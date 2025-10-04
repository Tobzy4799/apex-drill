// lib/startCampaignStream.ts
import { TwitterApi } from "twitter-api-v2";
import mongoose, { Schema, model, models } from "mongoose";
import { Campaign } from "@/models/Campaign";
import { User } from "@/models/User";
import { Leaderboard } from "@/models/Leaderboard";
import { connectToDB } from "@/lib/mongodb";
import { scoreCreatorPost } from "@/lib/apex-academia-scoring";

type TrackedTweetDoc = {
  tweetId: string;
  authorId: string;
  username: string;
  avatar?: string;
  public_metrics: {
    like_count: number;
    retweet_count: number;
    reply_count: number;
    quote_count: number;
  };
  lastScore: number;
  refreshStage: number;
  nextRefreshAt: Date | null;
  campaignId: mongoose.Types.ObjectId;
};

/* -------------------- Minimal TrackedTweet model -------------------- */
const TrackedTweetSchema = new Schema(
  {
    campaignId: { type: Schema.Types.ObjectId, required: true, index: true },
    tweetId: { type: String, required: true, index: true },
    authorId: { type: String, required: true, index: true },
    username: { type: String, required: true },
    avatar: { type: String },
    public_metrics: {
      like_count: { type: Number, default: 0 },
      retweet_count: { type: Number, default: 0 },
      reply_count: { type: Number, default: 0 },
      quote_count: { type: Number, default: 0 },
    },
    lastScore: { type: Number, default: 0 },
    refreshStage: { type: Number, default: 0 },
    nextRefreshAt: { type: Date, index: true, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);
TrackedTweetSchema.index({ campaignId: 1, tweetId: 1 }, { unique: true });
const TrackedTweet =
  (models as any).TrackedTweet || model("TrackedTweet", TrackedTweetSchema);

/* ----------------------- Tunables ----------------------- */
const SOFT_BUDGET_MS = 7000;
const MAX_USERS_PER_RUN = 5; // your current setting
const MAX_RESULTS = 2;
const TWEET_FIELDS = "public_metrics,author_id,text,created_at";
const USE_ROLLING_WINDOW = true;
const ROLLING_DAYS = 3;
const ACTIVE_BACKOFF_MS = 5 * 60 * 1000;
const QUIET_BACKOFF_MS = 45 * 60 * 1000;
const HYDRATE_SOFT_BUDGET_MS = 7000;
const HYDRATE_BATCH_TWEETS = 100;
const REFRESH_OFFSETS = [
  15 * 60 * 1000,
  2 * 60 * 60 * 1000,
  12 * 60 * 60 * 1000,
  48 * 60 * 60 * 1000,
  72 * 60 * 60 * 1000,
];

/* -------------------------- Helpers -------------------------- */
function nowIsoMinusDays(days: number) {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}
function normalize(text = "") {
  return text.normalize("NFKC").toLowerCase();
}
function buildKeywordMatchers(keys: string[]) {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return keys.map((k) => {
    const v = esc(k.toLowerCase());
    if (k.startsWith("$") || k.startsWith("@") || k.startsWith("#")) {
      return new RegExp(`(^|\\W)${v}($|\\W)`, "i");
    }
    return new RegExp(`\\b${v}\\b`, "i");
  });
}
function matchesAny(text: string, regs: RegExp[]) {
  const t = normalize(text);
  for (const r of regs) if (r.test(t)) return true;
  return false;
}
const isNumericSnowflake = (v: any) => typeof v === "string" ? /^\d+$/.test(v) : /^\d+$/.test(String(v));

/* ======================= NEW-TWEET POLLER ======================= */
export async function startCampaignStream(campaignId: string) {
  console.log(`▶️ Starting campaign stream for ${campaignId}`);
  const started = Date.now();
  const timeLeft = () => SOFT_BUDGET_MS - (Date.now() - started);
  const ensureTime = (reserve = 250) => {
    if (timeLeft() < reserve) throw new Error("⏱ Time budget reached");
  };

  await connectToDB();
  ensureTime();

  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign?.keywords?.length) {
    console.warn(`⚠ Campaign ${campaignId} missing or has no keywords`);
    return;
  }
  const matchers = buildKeywordMatchers(campaign.keywords);

  let totalMatchedTweets = 0;

  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    console.error("❌ Missing X_BEARER_TOKEN");
    return;
  }
  const twitter = new TwitterApi(token);

  const now = new Date();
  const fields = "twitterId username avatar sinceId lastPolledAt nextPollAt";

  // Step 1: grab users that are due OR never polled
  const dueUsers = await User.find(
    {
      enabled: { $ne: false },
      $or: [
        { nextPollAt: { $lte: now } },
        { nextPollAt: { $exists: false } },
        { lastPolledAt: { $exists: false } },
      ],
    },
    fields
  )
    .sort({ lastPolledAt: 1, _id: 1 })
    .limit(MAX_USERS_PER_RUN)
    .lean();

  // Step 2: top up with oldest-polled users to fill the batch
  let users = dueUsers;
  if (users.length < MAX_USERS_PER_RUN) {
    const need = MAX_USERS_PER_RUN - users.length;
    const exclude = users.map((u) => u._id);
    const topUp = await User.find(
      {
        enabled: { $ne: false },
        _id: { $nin: exclude },
      },
      fields
    )
      .sort({ lastPolledAt: 1, _id: 1 })
      .limit(need)
      .lean();
    users = users.concat(topUp);
  }

  if (!users.length) {
    console.warn("⚠ No users to poll");
    return;
  }

  // FIX A: pre-mark the batch so rotation advances even if we break early
  try {
    await User.updateMany(
      { _id: { $in: users.map(u => (u as any)._id) } },
      { $set: { lastPolledAt: new Date() } }
    );
  } catch (e) {
    console.warn("⚠ Failed to pre-mark batch users:", (e as any)?.message || e);
  }

  console.log("Polling users:", users.map((u) => u.username).join(", "));
  const deltaMap: Record<
    string,
    { author_id: string; username: string; avatar: string; score: number }
  > = {};

  for (const u of users) {
    // FIX B: if budget is low, break cleanly (don’t throw)
    if (timeLeft() < 600) {
      console.warn("⏱ Budget low; breaking loop to finish cleanly");
      break;
    }

    try {
      // --- PREVALIDATE IDs ---
      const userId = String((u as any).twitterId ?? "").trim();
      const hasNumericUserId = isNumericSnowflake(userId);
      if (!hasNumericUserId) {
        console.warn(`△ Skipping @${u.username}: twitterId is not numeric (${userId})`);
        await User.updateOne(
          { _id: (u as any)._id },
          { $set: { lastPolledAt: new Date(), nextPollAt: new Date(Date.now() + 60 * 60 * 1000) } }
        );
        continue;
      }

      const maybeSinceId = (u.sinceId ?? "").toString();
      const hasValidSinceId = isNumericSnowflake(maybeSinceId);

      // Build base params
      const baseParams: Record<string, any> = {
        max_results: MAX_RESULTS,
        "tweet.fields": TWEET_FIELDS,
      };
      if (USE_ROLLING_WINDOW) baseParams.start_time = nowIsoMinusDays(ROLLING_DAYS);

      // Try patterns to avoid 400s:
      // 1) since_id + start_time (if sinceId valid)
      // 2) only since_id
      // 3) only start_time
      const attemptParamsList: Record<string, any>[] = [];
      if (hasValidSinceId) {
        attemptParamsList.push({ ...baseParams, since_id: maybeSinceId });
        attemptParamsList.push({ max_results: MAX_RESULTS, "tweet.fields": TWEET_FIELDS, since_id: maybeSinceId });
      }
      attemptParamsList.push({ max_results: MAX_RESULTS, "tweet.fields": TWEET_FIELDS, ...(USE_ROLLING_WINDOW ? { start_time: nowIsoMinusDays(ROLLING_DAYS) } : {}) });

      let tweets: any[] = [];
      let lastErr: any = null;

      for (const p of attemptParamsList) {
        try {
          const tl = await twitter.v2.userTimeline(userId, p);
          tweets = tl.data?.data ?? [];
          lastErr = null;
          break;
        } catch (err: any) {
          lastErr = err;
          // If it’s a 400, try next param shape; if something else, break
          const status = Number(err?.code || err?.data?.status || err?.status);
          if (status !== 400) break;
          console.warn(`↻ Retrying @${u.username} with different params due to 400`);
        }
      }
      if (lastErr && !tweets.length) {
        throw lastErr;
      }

      console.log(`ℹ @${u.username} fetched ${tweets.length} tweets`);

      let newest: string | null = (hasValidSinceId ? maybeSinceId : u.sinceId) || null;
      let matchedCount = 0;

      for (const tw of tweets) {
        if (!tw?.text || !tw.public_metrics) continue;
        if (!matchesAny(tw.text, matchers)) continue;

        matchedCount++;
        totalMatchedTweets++;

        const score = scoreCreatorPost(
          {
            id: tw.id!,
            text: tw.text,
            created_at: tw.created_at,
            public_metrics: tw.public_metrics,
          },
          0
        );

        await TrackedTweet.updateOne(
          {
            campaignId: new mongoose.Types.ObjectId(campaignId),
            tweetId: tw.id!,
          },
          {
            $setOnInsert: {
              authorId: tw.author_id!,
              username: u.username,
              avatar: u.avatar || "/avatar1.png",
              createdAt: new Date(),
            },
            $set: {
              public_metrics: tw.public_metrics,
              lastScore: score,
              refreshStage: 0,
              nextRefreshAt: new Date(Date.now() + REFRESH_OFFSETS[0]),
            },
          },
          { upsert: true }
        );

        if (!deltaMap[tw.author_id!]) {
          deltaMap[tw.author_id!] = {
            author_id: tw.author_id!,
            username: u.username,
            avatar: u.avatar || "/avatar1.png",
            score: 0,
          };
        }
        deltaMap[tw.author_id!].score += score;

        if (!newest || BigInt(tw.id) > BigInt(newest)) newest = tw.id;
      }

      const nextPollAt =
        matchedCount > 0
          ? new Date(Date.now() + ACTIVE_BACKOFF_MS)
          : new Date(Date.now() + QUIET_BACKOFF_MS);

      await User.updateOne(
        { _id: (u as any)._id },
        {
          $set: {
            sinceId: newest ?? u.sinceId ?? null,
            lastPolledAt: new Date(),
            nextPollAt,
          },
        }
      );
    } catch (e: any) {
      console.warn(`⚠ Poll fail @${u.username}: ${e?.message || e}`);
      await User.updateOne(
        { _id: (u as any)._id },
        {
          $set: {
            lastPolledAt: new Date(),
            nextPollAt: new Date(Date.now() + 10 * 60 * 1000),
          },
        }
      );
    }
  }

  ensureTime(300);

  console.log(`Total matched tweets this run: ${totalMatchedTweets}`);

  const deltaRows = Object.values(deltaMap);
  if (!deltaRows.length) {
    console.log("ℹ No deltas to merge into leaderboard");
    return;
  }

  const existing = await Leaderboard.findOne(
    { campaignId: new mongoose.Types.ObjectId(campaignId) },
    { data: 1 }
  ).lean<{ data: any[] }>();

  const totalsById = new Map<
    string,
    { author_id: string; username: string; avatar: string; score: number }
  >();

  if (existing?.data?.length) {
    for (const row of existing.data) {
      totalsById.set(row.author_id, {
        author_id: row.author_id,
        username: row.username,
        avatar: row.avatar,
        score: Number(row.score) || 0,
      });
    }
  }

  for (const row of deltaRows) {
    const prev = totalsById.get(row.author_id);
    if (prev) {
      prev.username = row.username || prev.username;
      prev.avatar = row.avatar || prev.avatar;
      prev.score += row.score;
    } else {
      totalsById.set(row.author_id, { ...row });
    }
  }

  const merged = Array.from(totalsById.values()).sort(
    (a, b) => b.score - a.score
  );

  await Leaderboard.updateOne(
    { campaignId: new mongoose.Types.ObjectId(campaignId) },
    { $set: { data: merged, updatedAt: new Date() } },
    { upsert: true }
  );

  console.log(
    `✅ Leaderboard updated for ${campaignId}: ${
      deltaRows.length
    } authors got points, total delta points: ${deltaRows.reduce(
      (sum, r) => sum + r.score,
      0
    )}`
  );
}

/* ========================= 72H HYDRATOR ========================= */
export async function refreshTweetMetrics(campaignId: string) {
  console.log(`▶️ Starting hydration for ${campaignId}`);
  const started = Date.now();
  const timeLeft = () => HYDRATE_SOFT_BUDGET_MS - (Date.now() - started);
  const ensureTime = (reserve = 300) => {
    if (timeLeft() < reserve) throw new Error("⏱ Hydration budget reached");
  };

  await connectToDB();
  ensureTime();

  const token = process.env.X_BEARER_TOKEN;
  if (!token) {
    console.error("❌ Missing X_BEARER_TOKEN");
    return;
  }
  const twitter = new TwitterApi(token);

  const due = (await TrackedTweet.find({
    campaignId: new mongoose.Types.ObjectId(campaignId),
    nextRefreshAt: { $lte: new Date() },
    refreshStage: { $lt: REFRESH_OFFSETS.length },
  })
    .limit(HYDRATE_BATCH_TWEETS)
    .lean()) as TrackedTweetDoc[];

  console.log(`ℹ ${due.length} tweets due for hydration`);

  if (!due.length) return;

  const ids = due.map((d) => d.tweetId);
  const res = await twitter.v2.tweets(ids, { "tweet.fields": TWEET_FIELDS });
  ensureTime();

  const liveById = new Map<string, any>();
  for (const t of res.data ?? []) liveById.set(t.id, t);

  const hydrateDelta: Record<
    string,
    { author_id: string; username: string; avatar: string; score: number }
  > = {};

  for (const doc of due) {
    const live = liveById.get(doc.tweetId);

    if (!live || !live.public_metrics) {
      await TrackedTweet.updateOne(
        { campaignId: doc.campaignId, tweetId: doc.tweetId },
        { $set: { refreshStage: REFRESH_OFFSETS.length, nextRefreshAt: null } }
      );
      continue;
    }

    const newScore = scoreCreatorPost(
      {
        id: live.id,
        text: live.text || "",
        created_at: live.created_at,
        public_metrics: live.public_metrics,
      },
      0
    );

    const delta = Math.max(0, newScore - (doc.lastScore || 0));

    const nextStage = Math.min(
      (doc.refreshStage || 0) + 1,
      REFRESH_OFFSETS.length
    );
    const nextAt =
      nextStage < REFRESH_OFFSETS.length
        ? new Date(Date.now() + REFRESH_OFFSETS[nextStage])
        : null;

    await TrackedTweet.updateOne(
      { campaignId: doc.campaignId, tweetId: doc.tweetId },
      {
        $set: {
          public_metrics: live.public_metrics,
          lastScore: newScore,
          refreshStage: nextStage,
          nextRefreshAt: nextAt,
        },
      }
    );

    if (delta > 0) {
      const authorId = doc.authorId;
      if (!hydrateDelta[authorId]) {
        hydrateDelta[authorId] = {
          author_id: authorId,
          username: doc.username,
          avatar: doc.avatar || "/avatar1.png",
          score: 0,
        };
      }
      hydrateDelta[authorId].score += delta;
      console.log(
        `💧 Hydrated tweet ${doc.tweetId} -> +${delta} points for @${doc.username}`
      );
    }
  }

  ensureTime(300);

  const deltaRows = Object.values(hydrateDelta);
  if (!deltaRows.length) {
    console.log("ℹ No hydration deltas to merge into leaderboard");
    return;
  }

  const existing = await Leaderboard.findOne(
    { campaignId: new mongoose.Types.ObjectId(campaignId) },
    { data: 1 }
  ).lean<{ data: any[] }>();

  const totalsById = new Map<
    string,
    { author_id: string; username: string; avatar: string; score: number }
  >();

  if (existing?.data?.length) {
    for (const row of existing.data) {
      totalsById.set(row.author_id, {
        author_id: row.author_id,
        username: row.username,
        avatar: row.avatar,
        score: Number(row.score) || 0,
      });
    }
  }

  for (const row of deltaRows) {
    const prev = totalsById.get(row.author_id);
    if (prev) {
      prev.username = row.username || prev.username;
      prev.avatar = row.avatar || prev.avatar;
      prev.score += row.score;
    } else {
      totalsById.set(row.author_id, { ...row });
    }
  }

  const merged = Array.from(totalsById.values()).sort(
    (a, b) => b.score - a.score
  );

  await Leaderboard.updateOne(
    { campaignId: new mongoose.Types.ObjectId(campaignId) },
    { $set: { data: merged, updatedAt: new Date() } },
    { upsert: true }
  );

  console.log(
    `✅ Hydration leaderboard updated for ${campaignId}: ${
      deltaRows.length
    } authors, total delta points: ${deltaRows.reduce(
      (sum, r) => sum + r.score,
      0
    )}`
  );
}

// models/User.ts
import mongoose from "mongoose";

const UserSchema = new mongoose.Schema(
  {
    twitterId: { type: String, required: true, unique: true }, // from Twitter profile.id
    username: { type: String, required: true },
    avatar: { type: String },
    isAuthorized: { type: Boolean, default: false }, // 🔥 new field
  },
  { timestamps: true }
);

export const User =
  mongoose.models.User || mongoose.model("User", UserSchema);
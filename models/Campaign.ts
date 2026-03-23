// models/Campaign.ts
import mongoose, { Schema, Document, Model } from "mongoose";

export interface ICampaign extends Document {
  title: string;
  description: string;
  keywords: string[]; // array of keywords
  image?: string; // ✅ campaign image (optional)
  twitterLink?: string; // ✅ Twitter/X link (optional)
  createdBy: string; // ✅ username of the admin who created it
  status: "active" | "ended";
  createdAt: Date;
  updatedAt: Date;
}

const CampaignSchema: Schema = new Schema<ICampaign>(
  {
    title: { type: String, required: true },
    description: { type: String, required: true },
    keywords: { type: [String], required: true },
    image: { type: String }, // ✅ optional
    twitterLink: { type: String }, // ✅ optional
    createdBy: { type: String, required: true }, // ✅ must track creator
    status: { type: String, enum: ["active", "ended"], default: "active" },
  },
  { timestamps: true }
);

// Prevent model overwrite in development
export const Campaign: Model<ICampaign> =
  mongoose.models.Campaign || mongoose.model<ICampaign>("Campaign", CampaignSchema);



import mongoose from "mongoose";
import dotenv from "dotenv"
dotenv.config()

export const connectDB = async (): Promise<void> => {
  if (!process.env.MONGO_URI) {
    console.error("❌ Fatal Error: MONGO_URI environment variable is not defined!");
    process.exit(1);
  }
  try {
    const conn = await mongoose.connect(process.env.MONGO_URI);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    console.error("MongoDB connection failed:", error);
    process.exit(1);
  }
};

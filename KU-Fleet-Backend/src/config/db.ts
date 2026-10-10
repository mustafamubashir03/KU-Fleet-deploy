import mongoose from "mongoose";
import { validateRequiredEnv } from "./env";

// Never load the real .env (production credentials) while under test.


export const connectDB = async (): Promise<void> => {
  // Test safety guard: automated tests must never open the production database.
  if (process.env.NODE_ENV === "test" && !process.env.KUFLEET_TEST_MONGO_URI) {
    console.error(
      "❌ Refusing to connect to MongoDB under NODE_ENV=test. " +
        "Set KUFLEET_TEST_MONGO_URI to a disposable database to run integration tests."
    );
    process.exit(1);
  }

  validateRequiredEnv();
  try {
    const uri = process.env.MONGO_URI as string;
    const conn = await mongoose.connect(uri);
    console.log(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    // Never echo the URI: it embeds the username and password.
    console.error(
      "MongoDB connection failed:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
};

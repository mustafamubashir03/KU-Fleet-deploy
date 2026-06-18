import { Request, Response } from "express";
import Feedback from "../models/Feedback.model";
import Bus from "../models/Bus.model";
import User from "../models/User.model";
import { wrapAsync } from "../middleware/errorHandler";

/** ✅ Submit Feedback (linked with Bus and RFID) */
export const submitFeedback = wrapAsync(async (req: Request, res: Response) => {
  const { busId, rating, comment, type, rfidCardUID } = req.body;

  if (!busId || !rating) {
    return res.status(400).json({ message: "Bus ID and rating are required" });
  }

  const bus = await Bus.findById(busId);
  if (!bus) return res.status(404).json({ message: "Bus not found" });

  let user = null;
  if (rfidCardUID) {
    user = await User.findOne({ rfidCardUID });
    if (!user) {
      return res
        .status(404)
        .json({ message: "RFID not found. Please scan a valid student card." });
    }
  }

  const feedback = await Feedback.create({
    bus: busId,
    user: user?._id,
    rating,
    comment,
    type: type || "general",
    resolved: false,
  });

  res.status(201).json({
    success: true,
    message: "Feedback submitted successfully",
    feedback,
  });
});

/** ✅ Get All Feedbacks (Admin View) */
export const getAllFeedbacks = wrapAsync(async (_req: Request, res: Response) => {
  const feedbacks = await Feedback.find()
    .populate("bus", "busNumber")
    .populate("user", "name email rfidCardUID")
    .sort({ createdAt: -1 });

  res.status(200).json({ success: true, count: feedbacks.length, feedbacks });
});

/** ✅ Get Feedback by Bus */
export const getFeedbackByBus = wrapAsync(async (req: Request, res: Response) => {
  const { busId } = req.params;
  const feedbacks = await Feedback.find({ bus: busId }).sort({ createdAt: -1 });

  if (!feedbacks.length)
    return res.status(404).json({ message: "No feedback found for this bus" });

  res.status(200).json({ success: true, count: feedbacks.length, feedbacks });
});

/** ✅ Mark Feedback as Resolved (Admin Action) */
export const resolveFeedback = wrapAsync(async (req: Request, res: Response) => {
  const { id } = req.params;
  const { response } = req.body;

  const feedback = await Feedback.findById(id);
  if (!feedback) return res.status(404).json({ message: "Feedback not found" });

  feedback.resolved = true;
  feedback.response = response || "Marked as resolved";
  await feedback.save();

  res.status(200).json({ success: true, message: "Feedback resolved", feedback });
});

/** ✅ Delete Feedback (Admin Only) */
export const deleteFeedback = wrapAsync(async (req: Request, res: Response) => {
  const deleted = await Feedback.findByIdAndDelete(req.params.id);
  if (!deleted) return res.status(404).json({ message: "Feedback not found" });

  res.status(200).json({ success: true, message: "Feedback deleted successfully" });
});

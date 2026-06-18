import { Request, Response } from "express";
import User from "../models/User.model";
import { wrapAsync } from "../middleware/errorHandler";


export const getAllUsers = wrapAsync(async (req: Request, res: Response) => {
  const users = await User.find().select("-password");
  res.status(200).json(users);
});


export const getUserById = wrapAsync(async (req: Request, res: Response) => {
  const user = await User.findById(req.params.id).select("-password");
  if (!user) return res.status(404).json({ message: "User not found" });
  res.status(200).json(user);
});


export const updateUser = wrapAsync(async (req: Request, res: Response) => {
  const { name, email, role, active } = req.body;
  const updated = await User.findByIdAndUpdate(
    req.params.id,
    { name, email, role, active },
    { new: true }
  ).select("-password");
  if (!updated) return res.status(404).json({ message: "User not found" });
  res.status(200).json(updated);
});

//Admin only (soft delete)
export const deactivateUser = wrapAsync(async (req: Request, res: Response) => {
  const user = await User.findByIdAndUpdate(req.params.id, { active: false }, { new: true });
  if (!user) return res.status(404).json({ message: "User not found" });
  res.status(200).json({ message: "User deactivated", user });
});

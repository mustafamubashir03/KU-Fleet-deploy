import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.model";

interface DecodedToken {
  id: string;
  iat: number;
  exp: number;
}

export const protect = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer "))
      return res.status(401).json({ message: "Not authorized, no token" });

    const token = authHeader.split(" ")[1];
    const jwtSecret = process.env.JWT_SECRET;
    if (!jwtSecret) return res.status(500).json({ message: "JWT secret not configured" });
    
    // Pin the algorithm. verifyToken() in utils/generateToken.ts already does
    // this; this middleware was calling jwt.verify() without it.
    const decoded = jwt.verify(token as string, jwtSecret, {
      algorithms: ["HS256"],
    }) as unknown as DecodedToken;
    if (!decoded.id) return res.status(401).json({ message: "Invalid token" });

    const user = await User.findById(decoded.id).select("-password");
    if (!user) return res.status(401).json({ message: "User not found" });

    (req as any).user = user;
    next();
  } catch (error) {
    res.status(401).json({ message: "Invalid token" });
  }
};

export const adminOnly = (req: Request, res: Response, next: NextFunction) => {
  const user = (req as any).user;
  if (user?.role !== "admin") return res.status(403).json({ message: "Admin access only" });
  next();
};

import { Request, Response } from "express";
import bcrypt from "bcrypt";
import User from "../models/User.model";
import { IUser } from "../interfaces/User";
import { generateToken } from "../utils/generateToken";

/** ----------------- GENERAL USER ----------------- */

/** Roles that may be requested through this UNAUTHENTICATED endpoint. */
export const ALL_ROLES = ["admin", "driver", "student", "parent"] as const;

export type RoleValidation =
  | { ok: true; role: (typeof ALL_ROLES)[number] }
  | { ok: false; status: 400 | 403; message: string };

/**
 * Decide which role a public registration may create.
 *
 * `/api/auth/register` is unauthenticated, so honouring a client-supplied
 * `role` verbatim would let anyone POST {role:"admin"} and take over the
 * deployment. Admin is therefore refused unless an operator explicitly opts in
 * with ALLOW_ADMIN_BOOTSTRAP=true (used once to create the first admin).
 *
 * Extracted as a pure function so the rule can be tested without a database.
 */
export function validateRequestedRole(
  requestedRole: unknown,
  adminBootstrapEnabled: boolean
): RoleValidation {
  if (requestedRole === undefined || requestedRole === null) {
    // Same default as the User schema.
    return { ok: true, role: "student" };
  }

  if (
    typeof requestedRole !== "string" ||
    !ALL_ROLES.includes(requestedRole as (typeof ALL_ROLES)[number])
  ) {
    return {
      ok: false,
      status: 400,
      message: `Invalid role. Allowed values: ${ALL_ROLES.join(", ")}`,
    };
  }

  if (requestedRole === "admin" && !adminBootstrapEnabled) {
    return {
      ok: false,
      status: 403,
      message:
        "Admin registration is not available on this endpoint. Ask an existing admin, or set ALLOW_ADMIN_BOOTSTRAP=true for first-time bootstrap only.",
    };
  }

  return { ok: true, role: requestedRole as (typeof ALL_ROLES)[number] };
}

export const registerUser = async (req: Request, res: Response) => {
  try {
    const { name, email, password, role } = req.body;

    // Email/password registration only for admin/driver/parent
    if (!email || !password) {
      return res.status(400).json({
        message: "Email and password are required for this registration type",
      });
    }

    // Validate the requested role instead of passing it straight to Mongoose
    // (an unknown value previously surfaced as a 500 from the enum check).
    const validated = validateRequestedRole(
      role,
      process.env.ALLOW_ADMIN_BOOTSTRAP === "true"
    );
    if (!validated.ok) {
      return res.status(validated.status).json({ message: validated.message });
    }

    const exists = await User.findOne({ email });
    if (exists)
      return res.status(400).json({ message: "User with this email already exists" });

    const hashed = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashed,
      role: validated.role,
    });

    res.status(201).json({
      message: "User registered successfully",
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Registration failed", error: error.message });
  }
};

export const loginUser = async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;

    if (!email || !password)
      return res.status(400).json({ message: "Email and password are required" });

    const user = await User.findOne({ email });
    if (!user) return res.status(404).json({ message: "User not found" });

    const match = await bcrypt.compare(password, user.password ?? "");
    if (!match) return res.status(401).json({ message: "Invalid credentials" });

    const token = generateToken(user._id.toString());

    res.status(200).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Login failed", error: error.message });
  }
};

/** ----------------- STUDENT SPECIFIC ----------------- */
// Admin registers student with RFID
export const registerStudent = async (req: Request, res: Response) => {
  try {
    const { name, rfidCardUID, email } = req.body;

    if (!name || !rfidCardUID) {
      return res.status(400).json({ message: "Name and RFID UID are required" });
    }

    // Normalize UID
    const normalizedUID = rfidCardUID.replace(/\s+/g, "").toUpperCase();

    // Check if UID already exists
    const exists = await User.findOne({ rfidCardUID: normalizedUID });
    if (exists) {
      return res.status(400).json({ message: "RFID UID already registered" });
    }

    // Prepare student data
    const studentData: Partial<IUser> = {
      name,
      rfidCardUID: normalizedUID,
      role: "student",
      status: "active",
    };

    if (email && email.trim() !== "") {
      studentData.email = email.trim();
    }

    // Create student
    const student = await User.create(studentData);

    res.status(201).json({ message: "Student registered successfully", student });
  } catch (error: any) {
    // Handle MongoDB duplicate key errors safely
    if (error.code === 11000 && error.keyValue && typeof error.keyValue === "object") {
      const keys = Object.keys(error.keyValue);
      if (keys.length > 0) {
        const key = keys[0];
        if (key) { // ✅ Type-safe check
          const value = error.keyValue[key];
          return res.status(400).json({ message: `${key} already exists: ${value}` });
        }
      }
    }

    res.status(500).json({ message: "Student registration failed", error: error.message });
  }
};


// -------------------
// Student Login via RFID
// -------------------
export const loginStudent = async (req: Request, res: Response) => {
  try {
    const { rfidCardUID } = req.body;

    if (!rfidCardUID) {
      return res.status(400).json({ message: "RFID UID required" });
    }

    const normalizedUID = rfidCardUID.replace(/\s+/g, "").toUpperCase();

    const student = await User.findOne({
      rfidCardUID: normalizedUID,
      role: "student",
      status: "active",
    }).lean<IUser | null>();

    if (!student) {
      return res.status(404).json({ message: "Invalid RFID card" });
    }

    const token = generateToken(student._id.toString());

    res.status(200).json({
      token,
      student: {
        id: student._id,
        name: student.name,
        rfidCardUID: student.rfidCardUID,
        email: student.email ?? null,
      },
    });
  } catch (error: any) {
    res.status(500).json({ message: "Student login failed", error: error.message });
  }
};

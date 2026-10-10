import express from "express";
import { loginStudent, loginUser, registerStudent, registerUser } from "../controllers/authController";
import { authRateLimiter } from "../middleware/security";



const router = express.Router();

// authRateLimiter (5 failures / 15 min, successful requests are not counted)
// existed but was never mounted, leaving login and register unthrottled.
router.post("/register", authRateLimiter, registerUser);
router.post("/login", authRateLimiter, loginUser);
router.post("/students/register", authRateLimiter, registerStudent);
router.post("/students/login", authRateLimiter, loginStudent);


export default router;

import { Router } from "express";
import { getAllRfidLogs, getBusRfidLogs, getStudentRfidLogs, handleRfidScan } from "../controllers/rfidController";
import { adminOnly, protect } from "../middleware/AuthMiddleware";

const router = Router();

router.post("/scan", protect, handleRfidScan);
// 2️⃣ Get all RFID logs (admin only)
router.get("/logs", protect, getAllRfidLogs);

// 3️⃣ Get logs for a specific student (by studentId or rfidCardUID)
router.get("/student", protect, getStudentRfidLogs);

// 4️⃣ Get logs for a specific bus (by busId)
router.get("/bus/:busId", protect, adminOnly, getBusRfidLogs);

export default router;

import authRoutes from "./routes/authRoutes";
import userRoutes from "./routes/userRoutes";
import busRoutes from "./routes/busRoutes"
import driverRoutes from "./routes/driverRoutes";
import analyticRoutes from "./routes/analyticsRoutes"
import stationRoutes from "./routes/stationRoutes"
import routeRoutes from "./routes/routeRoutes"
import tripRoutes from "./routes/tripRoutes"
import feedbackRoutes from "./routes/feebackRoutes"
import alertRoutes from "./routes/alertRoutes"
import uploadRoutes from "./routes/uploadRoutes"
import cors from "cors"
import dotenv from "dotenv"
import express from 'express'
import { connectDB } from "./config/db";
import "./workers/workers";
import "./workers/cleanupWorker";
import "./workers/cronJobs";
dotenv.config()
const PORT = 3000
const app = express()
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors())

app.use("/api/auth", authRoutes);
app.use("/api/users", userRoutes);
app.use("/api/buses", busRoutes);
app.use("/api/drivers", driverRoutes);
app.use("/api/analytics",analyticRoutes)
app.use("/api/stations",stationRoutes)
app.use("/api/routes",routeRoutes)
app.use("/api/tripLogs",tripRoutes)
app.use("/api/feedback",feedbackRoutes)
app.use("/api/alerts", alertRoutes);
app.use("/api/upload", uploadRoutes);

connectDB().then(()=>{
    app.listen(process.env.PORT,()=>{
        console.log('app has been started at port',PORT)
    })

})


app.get("/",(_,res)=>{
    res.json({message:"KU Fleet Backend is up"})
})

app.get("/students/test", (_req, res) => {
    res.json({
      success: true,
      message: "Student auth routes are LIVE",
      timestamp: new Date().toISOString(),
    });
  });
  
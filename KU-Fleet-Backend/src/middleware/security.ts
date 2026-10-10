// src/middleware/security.ts
// Security middleware: Helmet, rate limiting, input sanitization, NoSQL injection protection

import { Request, Response, NextFunction } from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import { Types } from "mongoose";
import express from "express";

/**
 * Helmet configuration for security headers
 * Prevents XSS, clickjacking, MIME sniffing, and other attacks
 */
export const securityHeaders = helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https://res.cloudinary.com"],
      connectSrc: ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Allow Cloudinary images
});

/**
 * Rate limiting for authentication endpoints
 * Prevents brute force attacks
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5, // 5 requests per window
  message: "Too many login attempts, please try again later",
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful logins
});

/**
 * General API rate limiter
 * Prevents API abuse
 */
export const apiRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 100, // 100 requests per minute
  message: "Too many requests, please slow down",
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * Strict rate limiter for sensitive operations
 * Used for bus location updates, alerts, etc.
 */
export const strictRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 20, // 20 requests per minute
  message: "Rate limit exceeded for this operation",
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * NoSQL Injection Protection
 * Sanitizes request body, query, and params to prevent MongoDB injection attacks
 * Example attack: { $ne: null } or { $gt: "" } in query params
 */
export const sanitizeInput = (req: Request, res: Response, next: NextFunction): void => {
  /**
   * Strip MongoDB operators from body, query and params.
   *
   * Express 5 defines `req.query` as a GETTER-ONLY property on the request
   * instance. A plain `req.query = value` therefore throws
   *   "Cannot set property query of #<IncomingMessage> which has only a getter"
   * and turns EVERY request into a 500. It must be replaced with
   * Object.defineProperty, which can shadow the accessor.
   */
  const stripOperators = (obj: any): any => {
    if (obj === null || obj === undefined || typeof obj !== "object") return obj;
    for (const key of Object.keys(obj)) {
      if (key.startsWith("$")) {
        delete obj[key];
      } else {
        stripOperators(obj[key]);
      }
    }
    return obj;
  };

  if (req.body) stripOperators(req.body);

  if (req.params) stripOperators(req.params);

  // Shadow the getter-only `query` accessor with a sanitized plain object.
  if (req.query) {
    const safeQuery = stripOperators({ ...req.query });
    Object.defineProperty(req, "query", {
      value: safeQuery,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }

  next();
};

/**
 * Validate MongoDB ObjectId
 * Prevents invalid ObjectId format errors and potential injection
 */
export const validateObjectId = (req: Request, res: Response, next: NextFunction): void => {
  const idFields = ["id", "_id", "busId", "driverId", "routeId", "userId", "tripId", "alertId", "feedbackId"];
  
  for (const field of idFields) {
    const value = req.params[field] || req.body[field] || req.query[field];
    if (value && !Types.ObjectId.isValid(value)) {
      res.status(400).json({ 
        message: `Invalid ${field} format`,
        error: "Invalid ObjectId" 
      });
      return;
    }
  }
  
  next();
};

/**
 * Prevent dangerous HTTP methods
 * Only allow safe methods
 */
export const restrictMethods = (req: Request, res: Response, next: NextFunction): void => {
  const allowedMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"];
  if (!allowedMethods.includes(req.method)) {
    res.status(405).json({ 
      message: "Method not allowed",
      allowed: allowedMethods 
    });
    return;
  }
  next();
};

/**
 * Request size limiter
 * Prevents large payload attacks
 * Note: This is handled in app.ts with express.json(), but kept here for reference
 */
export const requestSizeLimiter = (maxSize: string = "10mb") => {
  return express.json({ limit: maxSize });
};


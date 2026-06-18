// src/utils/validation.ts
// Input validation utilities using simple validation (Zod can be added later if needed)

import { Types } from "mongoose";

/**
 * Validate email format
 * Prevents invalid email addresses
 */
export const isValidEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

/**
 * Validate password strength
 * Minimum 6 characters (can be enhanced)
 */
export const isValidPassword = (password: string): boolean => {
  return typeof password === "string" && password.length >= 6;
};

/**
 * Validate MongoDB ObjectId
 * Prevents invalid ObjectId errors
 */
export const isValidObjectId = (id: string): boolean => {
  return Types.ObjectId.isValid(id);
};

/**
 * Sanitize string input
 * Removes dangerous characters and trims whitespace
 */
export const sanitizeString = (input: string): string => {
  if (typeof input !== "string") return "";
  return input.trim().replace(/[<>]/g, ""); // Remove potential HTML tags
};

/**
 * Validate coordinates (latitude/longitude)
 * Ensures valid GPS coordinates
 */
export const isValidCoordinate = (value: number): boolean => {
  return typeof value === "number" && !isNaN(value) && isFinite(value);
};

export const isValidLatitude = (lat: number): boolean => {
  return isValidCoordinate(lat) && lat >= -90 && lat <= 90;
};

export const isValidLongitude = (lng: number): boolean => {
  return isValidCoordinate(lng) && lng >= -180 && lng <= 180;
};

/**
 * Validate IMEI format (15 digits)
 */
export const isValidIMEI = (imei: string): boolean => {
  return /^\d{15}$/.test(imei);
};

/**
 * Validate phone number (basic)
 */
export const isValidPhone = (phone: string): boolean => {
  return /^\+?[\d\s-()]{10,}$/.test(phone);
};

/**
 * Coerce Express route param to a single string (handles string | string[]).
 */
export const routeParam = (value: string | string[] | undefined): string => {
  if (value === undefined) return "";
  return Array.isArray(value) ? value[0] ?? "" : value;
};

/**
 * Validate required fields
 * Returns array of missing fields
 */
export const validateRequired = (data: Record<string, any>, required: string[]): string[] => {
  const missing: string[] = [];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null || data[field] === "") {
      missing.push(field);
    }
  }
  return missing;
};


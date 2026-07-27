import { z } from "zod";
import {
  normalizeProjectRelativePath,
  normalizeProjectTexPath,
} from "@/lib/storage/path-security";
import { MAX_TEXT_CONTENT_BYTES } from "@/lib/storage/resource-limits";

const textContentSchema = z.string().refine(
  (content) => Buffer.byteLength(content, "utf-8") <= MAX_TEXT_CONTENT_BYTES,
  { message: `Content exceeds ${MAX_TEXT_CONTENT_BYTES} bytes` }
);

export function validateFilePath(filePath: string): {
  valid: boolean;
  error?: string;
} {
  try {
    normalizeProjectRelativePath(filePath);
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Invalid file path",
    };
  }
}

export const registerSchema = z.object({
  email: z.string().email("Invalid email address"),
  name: z.string().trim().min(1, "Name is required").max(100, "Name is too long"),
  password: z
    .string()
    .min(8, "Password must be at least 8 characters"),
});

export const loginSchema = z.object({
  email: z.string().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export const createProjectSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Project name is required")
    .max(255, "Project name is too long"),
  description: z.string().trim().max(1000).optional(),
  engine: z.enum(["auto", "pdflatex", "xelatex", "latex"]).optional(),
  template: z
    .enum(["blank", "article", "thesis", "beamer", "letter"])
    .optional(),
});

export const updateProjectSchema = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  description: z.string().trim().max(1000).optional(),
  engine: z.enum(["auto", "pdflatex", "xelatex", "latex"]).optional(),
  mainFile: z
    .string()
    .max(500)
    .refine(
      (filePath) => {
        try {
          normalizeProjectTexPath(filePath);
          return true;
        } catch {
          return false;
        }
      },
      { message: "mainFile must be a project-relative .tex path" }
    )
    .optional(),
});

export const createFileSchema = z.object({
  path: z.string().min(1, "Path is required").max(1000),
  content: textContentSchema.optional(),
  isDirectory: z.boolean().optional(),
});

export const updateFileSchema = z.object({
  content: textContentSchema,
  autoCompile: z.boolean().optional().default(true),
});

export const renameFileSchema = z.object({
  newPath: z.string().min(1).max(1000),
});

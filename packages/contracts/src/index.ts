import { z } from 'zod';

export const emailSchema = z.string().trim().toLowerCase().email().max(254);
export const passwordSchema = z.string().min(10).max(128);
export const projectNameSchema = z.string().trim().min(1).max(200);

export const registerSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailSchema,
  password: passwordSchema,
});

export const loginSchema = z.object({ email: emailSchema, password: z.string().max(128) });

export const createProjectSchema = z.object({
  name: projectNameSchema,
  description: z.string().trim().max(2000).default(''),
});

export const updateProjectSchema = z.object({
  name: projectNameSchema.optional(),
  description: z.string().trim().max(2000).optional(),
}).refine((value) => Object.keys(value).length > 0, 'No changes supplied');

export const fileKindSchema = z.enum(['file', 'directory']);
export const createFileSchema = z.object({
  path: z.string().min(1).max(1000),
  kind: fileKindSchema,
  content: z.string().max(5_000_000).default(''),
});
export const updateFileSchema = z.object({
  path: z.string().min(1).max(1000).optional(),
  content: z.string().max(5_000_000).optional(),
}).refine((value) => value.path !== undefined || value.content !== undefined, 'No changes supplied');

export type UserDto = { id: string; name: string; email: string; createdAt: string };
export type ProjectRole = 'owner' | 'editor' | 'viewer';
export type ProjectDto = {
  id: string;
  name: string;
  description: string;
  role: ProjectRole;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type FileDto = {
  id: string;
  path: string;
  kind: 'file' | 'directory';
  mimeType: string | null;
  size: number;
  updatedAt: string;
};


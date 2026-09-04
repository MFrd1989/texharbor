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
  compiler: z.enum(['pdflatex', 'xelatex', 'lualatex']).optional(),
  mainFilePath: z.string().min(1).max(1000).optional(),
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

export const invitationSchema = z.object({ email: emailSchema, role: z.enum(['editor', 'viewer']) });
export const memberRoleSchema = z.object({ role: z.enum(['editor', 'viewer']) });
const relativePositionSchema = z.string().min(1).max(2048).regex(/^[A-Za-z0-9+/=_-]+$/, 'Invalid source position');
export const commentAnchorSchema = z.object({
  start: relativePositionSchema,
  end: relativePositionSchema,
  quote: z.string().max(1000),
});
export const createCommentThreadSchema = z.object({
  fileId: z.string().uuid(),
  body: z.string().trim().min(1).max(10000),
  anchor: commentAnchorSchema,
});
export const createCommentReplySchema = z.object({
  body: z.string().trim().min(1).max(10000),
  parentCommentId: z.string().uuid().optional(),
});
export const updateCommentThreadSchema = z.object({ status: z.enum(['open', 'resolved']) });

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
  isBinary: boolean;
  updatedAt: string;
};
export type CollaboratorDto = {
  id: string;
  name: string;
  email: string;
  role: ProjectRole;
  joinedAt: string;
};
export type InvitationDto = {
  id: string;
  email: string;
  role: Exclude<ProjectRole, 'owner'>;
  status: 'pending' | 'accepted' | 'rejected' | 'revoked' | 'expired';
  expiresAt: string;
  createdAt: string;
};
export type CommentAnchorDto = z.infer<typeof commentAnchorSchema>;
export type CommentDto = {
  id: string;
  authorId: string;
  authorName: string;
  parentCommentId: string | null;
  body: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
};
export type CommentThreadDto = {
  id: string;
  projectId: string;
  fileId: string;
  filePath: string;
  createdBy: string;
  anchor: CommentAnchorDto;
  status: 'open' | 'resolved';
  resolvedAt: string | null;
  resolvedBy: string | null;
  createdAt: string;
  updatedAt: string;
  comments: CommentDto[];
};
export type Compiler = 'pdflatex' | 'xelatex' | 'lualatex';
export type CompileJobDto = {
  id: string;
  projectId: string;
  status: 'queued' | 'running' | 'completed' | 'completed_with_errors' | 'failed';
  compiler: Compiler;
  mainFilePath: string;
  sourceHash: string;
  exitCode: number | null;
  log: string | null;
  hasPdf: boolean;
  queuedAt: string;
  startedAt: string | null;
  completedAt: string | null;
};

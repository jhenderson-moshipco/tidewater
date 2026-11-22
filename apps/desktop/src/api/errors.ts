import type { CommandError } from '../generated/errors';

export function isCommandError(value: unknown): value is CommandError {
  return typeof value === 'object' && value !== null && 'kind' in value && 'message' in value;
}

export function messageOf(error: unknown): string {
  if (isCommandError(error)) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

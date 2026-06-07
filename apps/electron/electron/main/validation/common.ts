/**
 * Common Validation Schemas
 *
 * Shared Zod schemas used across multiple handlers.
 */

import { z } from 'zod'

// =============================================================================
// Primitive Schemas
// =============================================================================

/**
 * UUID string validation
 */
export const UUIDSchema = z.string().uuid()

/**
 * ISO datetime string validation
 */
export const DateTimeSchema = z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/))

/**
 * ISO date string validation (YYYY-MM-DD)
 */
export const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

/**
 * Non-empty string
 */
export const NonEmptyStringSchema = z.string().min(1).max(1000)

/**
 * Optional string that can be null
 */
export const OptionalStringSchema = z.string().max(10000).nullable().optional()

/**
 * Positive integer
 */
export const PositiveIntSchema = z.number().int().positive()

/**
 * Non-negative integer
 */
export const NonNegativeIntSchema = z.number().int().nonnegative()

// =============================================================================
// Pagination Schemas
// =============================================================================

/**
 * Standard pagination parameters
 */
export const PaginationSchema = z.object({
  limit: z.number().int().min(1).max(100).optional().default(50),
  offset: z.number().int().min(0).optional().default(0)
})

/**
 * Search with pagination
 */
export const SearchPaginationSchema = PaginationSchema.extend({
  search: z.string().max(200).optional()
})

// =============================================================================
// Meeting Filter Schema
// =============================================================================

/**
 * Meeting status filter
 */
export const MeetingStatusSchema = z.enum(['all', 'recorded', 'transcribed'])

/**
 * Get meetings request with filters
 */
export const GetMeetingsRequestSchema = z.object({
  startDate: DateTimeSchema.optional(),
  endDate: DateTimeSchema.optional(),
  contactId: UUIDSchema.optional(),
  projectId: UUIDSchema.optional(),
  status: MeetingStatusSchema.optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(500).optional().default(100),
  offset: z.number().int().min(0).optional().default(0)
})

// =============================================================================
// Type Exports
// =============================================================================

export type Pagination = z.infer<typeof PaginationSchema>
export type SearchPagination = z.infer<typeof SearchPaginationSchema>
export type MeetingStatus = z.infer<typeof MeetingStatusSchema>
export type GetMeetingsRequest = z.infer<typeof GetMeetingsRequestSchema>

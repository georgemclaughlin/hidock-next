import { AlertCircle, CircleDashed, Clock, FileText, RefreshCw } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

export type SummaryBadgeStatus = 'none' | 'queued' | 'generating' | 'complete' | 'skipped' | 'failed'

interface SummaryStatusBadgeProps {
  status: SummaryBadgeStatus
  className?: string
}

const STATUS_LABELS: Record<SummaryBadgeStatus, string> = {
  none: 'Summary not generated',
  queued: 'Summary queued',
  generating: 'Summary generating',
  complete: 'Summary generated',
  skipped: 'Summary skipped',
  failed: 'Summary failed'
}

const STATUS_STYLES: Record<SummaryBadgeStatus, string> = {
  none: 'text-slate-400',
  queued: 'text-amber-500',
  generating: 'text-cyan-500',
  complete: 'text-emerald-500',
  skipped: 'text-amber-500',
  failed: 'text-red-500'
}

function getIcon(status: SummaryBadgeStatus) {
  switch (status) {
    case 'queued':
      return <Clock className="h-3.5 w-3.5" aria-hidden="true" />
    case 'generating':
      return <RefreshCw className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
    case 'skipped':
      return <CircleDashed className="h-3.5 w-3.5" aria-hidden="true" />
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5" aria-hidden="true" />
    case 'complete':
    case 'none':
    default:
      return <FileText className="h-3.5 w-3.5" aria-hidden="true" />
  }
}

export function SummaryStatusBadge({ status, className }: SummaryStatusBadgeProps) {
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              'inline-flex h-4 w-4 shrink-0 items-center justify-center',
              STATUS_STYLES[status],
              className
            )}
            aria-label={STATUS_LABELS[status]}
          >
            {getIcon(status)}
          </span>
        </TooltipTrigger>
        <TooltipContent>
          <p>{STATUS_LABELS[status]}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

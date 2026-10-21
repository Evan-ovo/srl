import {
  type ResourceCommunitySourceSummary,
  type ResourceCommunitySourceView,
} from '../types/CommunitySource'

export type DiscordCommunitySourcesProps = { resourceId: string }

export type DiscordCommunitySourcesEvents = { count: [value: number] }

export type RevisionViewMode = 'view' | 'compare'

export type SourcePresentation = ResourceCommunitySourceSummary | ResourceCommunitySourceView

export type RevisionComparisonItem = {
  key: string
  label: string
  authorName: string
  summary: string
}

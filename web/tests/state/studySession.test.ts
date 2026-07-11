import { describe, it, expect } from 'vitest'
import {
  studySessionTransition,
  initialStudySessionState,
  type StudySessionState,
  type StudySessionEvent,
  type BackendCard,
} from '../../src/state/studySession'
import type { CardContent } from '../../src/wasm/backend'

// Mock card/content for testing
const mockCard: BackendCard = { id: 1 }
const mockContent: CardContent = { question: 'Q', answer: 'A', css: '.card {}' }

describe('studySessionTransition', () => {
  it('starts from idle state on START event', () => {
    const state = studySessionTransition(initialStudySessionState, { type: 'START' })
    expect(state.status).toBe('loading')
  })

  it('ignores START event when already loading', () => {
    const loadingState: StudySessionState = { status: 'loading' }
    const state = studySessionTransition(loadingState, { type: 'START' })
    expect(state.status).toBe('loading')
  })

  it('transitions to reviewing (content not yet loaded) when card is loaded', () => {
    const loadingState: StudySessionState = { status: 'loading' }
    const state = studySessionTransition(loadingState, {
      type: 'CARD_LOADED',
      card: mockCard,
    })
    expect(state.status).toBe('reviewing')
    if (state.status === 'reviewing') {
      expect(state.card).toBe(mockCard)
      expect(state.content).toBeNull()
      expect(state.revealed).toBe(false)
    }
  })

  it('ignores CARD_LOADED when not in loading state', () => {
    const idleState: StudySessionState = { status: 'idle' }
    const state = studySessionTransition(idleState, {
      type: 'CARD_LOADED',
      card: mockCard,
    })
    expect(state.status).toBe('idle')
  })

  it('transitions to idle when queue is empty', () => {
    const loadingState: StudySessionState = { status: 'loading' }
    const state = studySessionTransition(loadingState, { type: 'QUEUE_EMPTY' })
    expect(state.status).toBe('idle')
  })

  it('ignores QUEUE_EMPTY when not in loading state', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: null,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, { type: 'QUEUE_EMPTY' })
    expect(state.status).toBe('reviewing')
  })

  it('stores content on CONTENT_LOADED while reviewing', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: null,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, {
      type: 'CONTENT_LOADED',
      content: mockContent,
    })
    expect(state.status).toBe('reviewing')
    if (state.status === 'reviewing') {
      expect(state.content).toBe(mockContent)
      expect(state.revealed).toBe(false)
    }
  })

  it('ignores CONTENT_LOADED when not reviewing', () => {
    const idleState: StudySessionState = { status: 'idle' }
    const state = studySessionTransition(idleState, {
      type: 'CONTENT_LOADED',
      content: mockContent,
    })
    expect(state.status).toBe('idle')
  })

  it('reveals the answer once content has loaded', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: mockContent,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, { type: 'REVEAL' })
    expect(state.status).toBe('reviewing')
    if (state.status === 'reviewing') {
      expect(state.revealed).toBe(true)
    }
  })

  it('ignores REVEAL before content has loaded', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: null,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, { type: 'REVEAL' })
    expect(state.status).toBe('reviewing')
    if (state.status === 'reviewing') {
      expect(state.revealed).toBe(false)
    }
  })

  it('transitions to answered when a revealed card is graded', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: mockContent,
      revealed: true,
    }
    const state = studySessionTransition(reviewingState, {
      type: 'ANSWER',
      ease: 3,
    })
    expect(state.status).toBe('answered')
    if (state.status === 'answered') {
      expect(state.card).toBe(mockCard)
      expect(state.content).toBe(mockContent)
      expect(state.ease).toBe(3)
    }
  })

  it('ignores ANSWER before the answer has been revealed', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: mockContent,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, {
      type: 'ANSWER',
      ease: 3,
    })
    expect(state.status).toBe('reviewing')
  })

  it('ignores ANSWER when not in reviewing state', () => {
    const idleState: StudySessionState = { status: 'idle' }
    const state = studySessionTransition(idleState, {
      type: 'ANSWER',
      ease: 3,
    })
    expect(state.status).toBe('idle')
  })

  it('transitions from answered to loading on NEXT', () => {
    const answeredState: StudySessionState = {
      status: 'answered',
      card: mockCard,
      content: mockContent,
      ease: 3,
    }
    const state = studySessionTransition(answeredState, { type: 'NEXT' })
    expect(state.status).toBe('loading')
  })

  it('ignores NEXT when not in answered state', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: null,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, { type: 'NEXT' })
    expect(state.status).toBe('reviewing')
  })

  it('transitions to error on ERROR event', () => {
    const idleState: StudySessionState = { status: 'idle' }
    const state = studySessionTransition(idleState, {
      type: 'ERROR',
      message: 'Test error',
    })
    expect(state.status).toBe('error')
    if (state.status === 'error') {
      expect(state.message).toBe('Test error')
    }
  })

  it('can transition from error to loading on START', () => {
    const errorState: StudySessionState = { status: 'error', message: 'Previous error' }
    const state = studySessionTransition(errorState, { type: 'START' })
    expect(state.status).toBe('loading')
  })

  it('resets to idle on RESET event', () => {
    const reviewingState: StudySessionState = {
      status: 'reviewing',
      card: mockCard,
      content: null,
      revealed: false,
    }
    const state = studySessionTransition(reviewingState, { type: 'RESET' })
    expect(state.status).toBe('idle')
  })

  it('returns unchanged state for unknown events', () => {
    const idleState: StudySessionState = { status: 'idle' }
    const state = studySessionTransition(idleState, {
      type: 'UNKNOWN',
    } as unknown as StudySessionEvent)
    expect(state).toBe(idleState)
  })
})

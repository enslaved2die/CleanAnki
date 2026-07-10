import { describe, it, expect } from 'vitest'
import {
  getOpfsRoot,
  opfsFileExists,
  openOrCreateOpfsFile,
  readOpfsFile,
  writeOpfsFile,
  deleteOpfsFile,
} from '../../src/db/opfs'

/**
 * NOTE: OPFS tests are stubs only. Full testing of OPFS functions requires a
 * real browser environment with navigator.storage.getDirectory() support, which
 * jsdom (this test runner's environment) does not provide.
 *
 * To properly test OPFS behavior, use integration tests in a real browser
 * environment (e.g., via Playwright, Cypress, or manual testing in the dev server).
 *
 * These stubs verify only that the module exports exist and have the expected types.
 */

describe('opfs module', () => {
  it('exports getOpfsRoot function', () => {
    expect(typeof getOpfsRoot).toBe('function')
  })

  it('exports opfsFileExists function', () => {
    expect(typeof opfsFileExists).toBe('function')
  })

  it('exports openOrCreateOpfsFile function', () => {
    expect(typeof openOrCreateOpfsFile).toBe('function')
  })

  it('exports readOpfsFile function', () => {
    expect(typeof readOpfsFile).toBe('function')
  })

  it('exports writeOpfsFile function', () => {
    expect(typeof writeOpfsFile).toBe('function')
  })

  it('exports deleteOpfsFile function', () => {
    expect(typeof deleteOpfsFile).toBe('function')
  })

  it('all exported functions are async', async () => {
    // Verify functions return promises without actually executing them
    // (execution would fail in jsdom without a real filesystem)
    expect(getOpfsRoot.constructor.name).toBe('AsyncFunction')
    expect(opfsFileExists.constructor.name).toBe('AsyncFunction')
    expect(openOrCreateOpfsFile.constructor.name).toBe('AsyncFunction')
    expect(readOpfsFile.constructor.name).toBe('AsyncFunction')
    expect(writeOpfsFile.constructor.name).toBe('AsyncFunction')
    expect(deleteOpfsFile.constructor.name).toBe('AsyncFunction')
  })
})

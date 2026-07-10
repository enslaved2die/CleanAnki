import { useState } from 'react'
import { motion } from 'framer-motion'

// Phase 1 scaffolding: placeholder form for sync configuration.
// Controlled inputs for endpoint URL and auth token — no actual sync logic yet.
// Will wire to src/wasm/backend.ts's syncWithServer(endpoint, token) in a later phase.

export default function SyncSettings() {
  const [endpoint, setEndpoint] = useState('')
  const [token, setToken] = useState('')
  const [showToken, setShowToken] = useState(false)

  const handleConnect = () => {
    console.log('Connect clicked (disabled for Phase 1)', { endpoint, token })
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      className="max-w-md space-y-6"
    >
      <div>
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Sync Endpoint URL
        </label>
        <input
          type="url"
          placeholder="https://sync.example.com"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          className="mt-2 w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-neutral-800"
        />
        <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          The server address where your cards are synced
        </p>
      </div>

      <div>
        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300">
          Auth Token
        </label>
        <div className="relative mt-2">
          <input
            type={showToken ? 'text' : 'password'}
            placeholder="••••••••••••••••"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 pr-11 text-neutral-900 placeholder-neutral-400 transition-colors focus:border-neutral-500 focus:outline-none focus:ring-2 focus:ring-neutral-200 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-100 dark:placeholder-neutral-500 dark:focus:ring-neutral-800"
          />
          <button
            type="button"
            onClick={() => setShowToken(!showToken)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-xs font-medium text-neutral-500 hover:text-neutral-700 dark:text-neutral-400 dark:hover:text-neutral-300"
          >
            {showToken ? 'Hide' : 'Show'}
          </button>
        </div>
        <p className="mt-1.5 text-xs text-neutral-500 dark:text-neutral-400">
          Your authentication token for the sync server
        </p>
      </div>

      <button
        type="button"
        onClick={handleConnect}
        disabled
        className="mt-6 w-full rounded-lg bg-neutral-900 px-4 py-2.5 font-medium text-white transition-colors hover:bg-neutral-800 disabled:opacity-50 disabled:cursor-not-allowed dark:bg-neutral-100 dark:text-neutral-900 dark:hover:bg-neutral-200 dark:disabled:opacity-50"
      >
        Connect (Phase 1: disabled)
      </button>

      <div className="rounded-lg bg-neutral-50 p-4 text-xs text-neutral-600 dark:bg-neutral-900/50 dark:text-neutral-400">
        <p className="font-medium">Phase 1 Note</p>
        <p className="mt-1">
          Real sync logic will be implemented once{' '}
          <code className="rounded bg-neutral-200 px-1 dark:bg-neutral-800">
            syncWithServer()
          </code>{' '}
          is available in the Rust backend.
        </p>
      </div>
    </motion.div>
  )
}

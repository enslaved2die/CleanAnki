import { useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import HomeView from './ui/HomeView'
import StudyView from './ui/StudyView'
import ImportView from './ui/ImportView'
import StatisticsView from './ui/StatisticsView'
import SyncSettings from './ui/SyncSettings'

type View = 'home' | 'study' | 'import' | 'stats' | 'sync'

const tabs: { id: View; label: string }[] = [
  { id: 'home', label: 'Home' },
  { id: 'study', label: 'Study' },
  { id: 'import', label: 'Import' },
  { id: 'stats', label: 'Stats' },
  { id: 'sync', label: 'Sync' },
]

function App() {
  const [view, setView] = useState<View>('home')
  // A login/sync holds the wasm bridge's collection lock on a background
  // thread for its whole duration (see SyncSettings' `onBusyChange` doc
  // comment) — navigating to another tab mid-sync would fire that tab's own
  // bridge call on the main thread and risk a hard crash, not just a stall.
  // Disabled tabs (rather than blocking `setView` itself) keeps this visible
  // to the user instead of a silent no-op click.
  const [syncBusy, setSyncBusy] = useState(false)

  return (
    <div className="min-h-svh bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-between border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
        <motion.h1
          className="text-lg font-semibold tracking-tight"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          CleanAnki
        </motion.h1>

        <nav className="flex gap-1 rounded-full bg-neutral-200/60 p-1 dark:bg-neutral-800/60">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              disabled={syncBusy && tab.id !== 'sync'}
              title={syncBusy && tab.id !== 'sync' ? 'A sync is in progress' : undefined}
              className={`relative rounded-full px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                view === tab.id
                  ? 'text-white'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {view === tab.id && (
                <motion.span
                  layoutId="active-tab"
                  className="absolute inset-0 rounded-full bg-neutral-900 dark:bg-neutral-100"
                  transition={{ type: 'spring', duration: 0.4, bounce: 0.2 }}
                />
              )}
              <span
                className={`relative z-10 ${view === tab.id ? 'dark:text-neutral-900' : ''}`}
              >
                {tab.label}
              </span>
            </button>
          ))}
        </nav>
      </header>

      <main className="mx-auto max-w-3xl px-6 py-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {view === 'home' && <HomeView onStudyDeck={() => setView('study')} />}
            {view === 'study' && <StudyView />}
            {view === 'import' && <ImportView />}
            {view === 'stats' && <StatisticsView />}
            {view === 'sync' && <SyncSettings onBusyChange={setSyncBusy} />}
          </motion.div>
        </AnimatePresence>
      </main>
    </div>
  )
}

export default App

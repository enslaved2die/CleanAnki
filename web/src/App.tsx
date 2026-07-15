import { useState, type ReactNode } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import HomeView from './ui/HomeView'
import StudyView from './ui/StudyView'
import DecksView from './ui/DecksView'
import ProfileView from './ui/ProfileView'

type View = 'home' | 'study' | 'decks' | 'profile'

/** Tiny hand-drawn line-art icons — no icon library exists in this project
 * (only framer-motion/react/tailwind are dependencies), so these are inline
 * SVGs matched to a consistent stroke width/viewBox rather than pulled in
 * from a package. */
function HomeIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M4 11.5 12 4l8 7.5" />
      <path d="M6 10v9a1 1 0 0 0 1 1h3v-6h4v6h3a1 1 0 0 0 1-1v-9" />
    </svg>
  )
}

function StudyIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="M12 6.5c-1.4-1.2-3.4-1.8-6-1.8v12.6c2.6 0 4.6.6 6 1.8" />
      <path d="M12 6.5c1.4-1.2 3.4-1.8 6-1.8v12.6c-2.6 0-4.6.6-6 1.8" />
      <path d="M12 6.5v12.6" />
    </svg>
  )
}

function DecksIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <path d="m12 4 8 4-8 4-8-4 8-4Z" />
      <path d="m4 12 8 4 8-4" />
      <path d="m4 16 8 4 8-4" />
    </svg>
  )
}

function ProfileIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="8.2" r="3.2" />
      <path d="M5 20c1-3.6 4-5.5 7-5.5s6 1.9 7 5.5" />
    </svg>
  )
}

function App() {
  const [view, setView] = useState<View>('home')
  // A login/sync holds the wasm bridge's collection lock on a background
  // thread for its whole duration (see ProfileView's `onBusyChange` doc
  // comment) — navigating to another tab mid-sync would fire that tab's own
  // bridge call on the main thread and risk a hard crash, not just a stall.
  // Disabled tabs (rather than blocking `setView` itself) keeps this visible
  // to the user instead of a silent no-op click.
  const [syncBusy, setSyncBusy] = useState(false)
  // Current sync auth state, surfaced by ProfileView — drives the Profile
  // tab's label ("Log In" vs "Profile").
  const [hkey, setHkey] = useState<string | null>(null)
  // Size of the queue the last "study" hand-off was for (root aggregate from
  // Home, or a single deck's total from Decks) — fed to StudyView as
  // `initialQueueTotal` to drive its real progress bar. `undefined` means "no
  // real target yet", which StudyView renders as a neutral indeterminate bar.
  const [studyTotal, setStudyTotal] = useState<number | undefined>(undefined)

  const goStudy = (total: number) => {
    setStudyTotal(total)
    setView('study')
  }

  const tabs: { id: View; label: string; icon: (className?: string) => ReactNode }[] = [
    { id: 'home', label: 'Home', icon: (c) => <HomeIcon className={c} /> },
    { id: 'study', label: 'Study', icon: (c) => <StudyIcon className={c} /> },
    { id: 'decks', label: 'Decks', icon: (c) => <DecksIcon className={c} /> },
    {
      id: 'profile',
      label: hkey ? 'Profile' : 'Log In',
      icon: (c) => <ProfileIcon className={c} />,
    },
  ]

  return (
    <div className="min-h-svh bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <header className="flex items-center justify-center border-b border-neutral-200 px-6 py-4 dark:border-neutral-800">
        <motion.h1
          className="text-lg font-semibold tracking-tight"
          initial={{ opacity: 0, y: -8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3 }}
        >
          CleanAnki
        </motion.h1>
      </header>

      <main className="mx-auto max-w-3xl px-6 pb-28 pt-10">
        <AnimatePresence mode="wait">
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.18 }}
          >
            {view === 'home' && <HomeView onStudyDeck={goStudy} />}
            {view === 'study' && <StudyView initialQueueTotal={studyTotal} />}
            {view === 'decks' && <DecksView onStudyDeck={goStudy} />}
            {view === 'profile' && (
              <ProfileView onBusyChange={setSyncBusy} onAuthChange={setHkey} />
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 border-t border-neutral-200 bg-white/90 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur dark:border-neutral-800 dark:bg-neutral-950/90"
        aria-label="Primary"
      >
        <div className="mx-auto flex max-w-3xl items-stretch justify-around px-2 pt-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setView(tab.id)}
              disabled={syncBusy && tab.id !== 'profile'}
              title={syncBusy && tab.id !== 'profile' ? 'A sync is in progress' : undefined}
              className={`relative flex flex-1 flex-col items-center gap-1 rounded-2xl px-2 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                view === tab.id
                  ? 'text-white'
                  : 'text-neutral-500 hover:text-neutral-900 dark:hover:text-white'
              }`}
            >
              {view === tab.id && (
                <motion.span
                  layoutId="active-tab"
                  className="absolute inset-0 rounded-2xl bg-indigo-600 dark:bg-indigo-500"
                  transition={{ type: 'spring', duration: 0.4, bounce: 0.2 }}
                />
              )}
              <span className="relative z-10">{tab.icon('h-5 w-5')}</span>
              <span className="relative z-10">{tab.label}</span>
            </button>
          ))}
        </div>
      </nav>
    </div>
  )
}

export default App

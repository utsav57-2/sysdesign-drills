import { NavLink, Route, Routes } from 'react-router-dom'
import Library from './pages/Library'
import QuestionPage from './pages/QuestionPage'
import Practice from './pages/Practice'
import Concepts from './pages/Concepts'
import ConceptPage from './pages/ConceptPage'
import History from './pages/History'

export default function App() {
  return (
    <div className="app">
      <header className="topbar">
        <NavLink to="/" className="brand">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <rect x="2.5" y="3.5" width="7" height="6" rx="1" />
            <rect x="14.5" y="3.5" width="7" height="6" rx="1" />
            <rect x="8.5" y="15" width="7" height="6" rx="1" />
            <path d="M6 9.5v3h12v-3M12 12.5V15" />
          </svg>
          Design Drills
        </NavLink>
        <nav>
          <NavLink to="/" end>
            Questions
          </NavLink>
          <NavLink to="/concepts">Concepts</NavLink>
          <NavLink to="/history">History</NavLink>
        </nav>
      </header>
      <Routes>
        <Route path="/" element={<Library />} />
        <Route path="/questions/:id" element={<QuestionPage />} />
        <Route path="/practice/:attemptId" element={<Practice />} />
        <Route path="/concepts" element={<Concepts />} />
        <Route path="/concepts/:id" element={<ConceptPage />} />
        <Route path="/history" element={<History />} />
        <Route path="*" element={<main className="page"><h1>Page not found</h1></main>} />
      </Routes>
    </div>
  )
}

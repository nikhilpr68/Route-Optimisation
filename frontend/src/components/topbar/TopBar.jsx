import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { listProjects } from '../../api/api';
import Logo from './Logo';
import Profile from './Profile';
import useScrollVisibility from './useScrollVisibility';
import './TopBar.css';

const TOP_BAR_HEIGHT = 64;

function SearchIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export default function TopBar({ scrollElement = null }) {
  const [searchText, setSearchText] = useState('');
  const [searching, setSearching] = useState(false);
  const [projects, setProjects] = useState([]);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const navigate = useNavigate();
  const location = useLocation();
  const visible = useScrollVisibility(scrollElement, { threshold: 10, topOffset: 20 });
  const searchWrapRef = useRef(null);

  const getProjectId = (p) => p?._id || p?.id;

  const findBestMatch = (projects, query) => {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return null;

    const scored = (Array.isArray(projects) ? projects : [])
      .map((project) => {
        const name = String(project?.name || '').trim();
        const n = name.toLowerCase();
        let score = Number.POSITIVE_INFINITY;
        if (n === q) score = 0;
        else if (n.startsWith(q)) score = 1;
        else if (n.includes(q)) score = 2;
        return { project, score, nameLen: name.length || 999 };
      })
      .filter((row) => Number.isFinite(row.score))
      .sort((a, b) => {
        if (a.score !== b.score) return a.score - b.score;
        return a.nameLen - b.nameLen;
      });

    return scored[0]?.project || null;
  };

  const handleSearch = async () => {
    const query = String(searchText || '').trim();
    if (!query || searching) {
      if (!query) navigate('/home');
      return;
    }

    setSearching(true);
    try {
      const data = await listProjects();
      const projects = Array.isArray(data) ? data : (data?.items || []);
      const match = findBestMatch(projects, query);
      const id = getProjectId(match);
      if (id) {
        navigate(`/projects/${id}`);
        return;
      }
      alert(`No project found for "${query}"`);
    } catch (err) {
      alert(err?.response?.data?.message || 'Unable to search projects right now.');
    } finally {
      setSearching(false);
    }
  };

  useEffect(() => {
    let mounted = true;
    const token = localStorage.getItem('token');
    if (!token) return undefined;

    (async () => {
      try {
        const data = await listProjects();
        if (!mounted) return;
        const list = Array.isArray(data) ? data : (data?.items || []);
        setProjects(list);
      } catch {
        if (!mounted) return;
        setProjects([]);
      }
    })();

    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    const onDocDown = (e) => {
      if (searchWrapRef.current && !searchWrapRef.current.contains(e.target)) {
        setDropdownOpen(false);
        setActiveIndex(-1);
      }
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, []);

  const filteredProjects = useMemo(() => {
    const q = String(searchText || '').trim().toLowerCase();
    if (!q) return [];
    return projects
      .filter((p) => String(p?.name || '').toLowerCase().includes(q))
      .sort((a, b) => String(a?.name || '').localeCompare(String(b?.name || '')))
      .slice(0, 8);
  }, [projects, searchText]);

  const openProject = (project) => {
    const id = getProjectId(project);
    if (!id) return;
    setDropdownOpen(false);
    setActiveIndex(-1);
    navigate(`/projects/${id}`);
  };

  return (
    <header className={`global-topbar ${visible ? 'is-visible' : 'is-hidden'}`} role="banner">
      <div className="global-topbar-inner">
        <div>
          <Logo />
        </div>

        <div className="global-topbar-center">
          <div className="global-topbar-search-wrap" ref={searchWrapRef}>
            <input
              type="text"
              className="global-topbar-search"
              placeholder="Search projects..."
              value={searchText}
              onChange={(e) => {
                setSearchText(e.target.value);
                setDropdownOpen(true);
                setActiveIndex(-1);
              }}
              onFocus={() => {
                if (searchText.trim()) setDropdownOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  if (!filteredProjects.length) return;
                  setDropdownOpen(true);
                  setActiveIndex((prev) => (prev + 1) % filteredProjects.length);
                  return;
                }
                if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  if (!filteredProjects.length) return;
                  setDropdownOpen(true);
                  setActiveIndex((prev) => (prev <= 0 ? filteredProjects.length - 1 : prev - 1));
                  return;
                }
                if (e.key === 'Enter') {
                  if (dropdownOpen && activeIndex >= 0 && filteredProjects[activeIndex]) {
                    e.preventDefault();
                    openProject(filteredProjects[activeIndex]);
                    return;
                  }
                  handleSearch();
                }
                if (e.key === 'Escape') {
                  setDropdownOpen(false);
                  setActiveIndex(-1);
                }
              }}
            />
            <button
              type="button"
              className="global-topbar-search-icon"
              onClick={handleSearch}
              aria-label="Search projects"
              disabled={searching}
            >
              <SearchIcon />
            </button>
            {dropdownOpen && searchText.trim() ? (
              <div className="global-topbar-dropdown">
                {filteredProjects.length ? (
                  filteredProjects.map((project, idx) => (
                    <button
                      key={String(getProjectId(project) || idx)}
                      type="button"
                      className={`global-topbar-dropdown-item ${idx === activeIndex ? 'active' : ''}`}
                      onClick={() => openProject(project)}
                    >
                      {project?.name || 'Untitled Project'}
                    </button>
                  ))
                ) : (
                  <div className="global-topbar-dropdown-empty">No matching projects</div>
                )}
              </div>
            ) : null}
          </div>
        </div>

        <div className="global-topbar-right">
          <button
            type="button"
            className={`global-topbar-action ${location.pathname === '/collaborate' ? 'is-active' : ''}`}
            onClick={() => navigate('/collaborate')}
          >
            <CollaborateIcon />
            <span>Collaborate</span>
          </button>
          <Profile />
        </div>
      </div>
    </header>
  );
}

function CollaborateIcon() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="9" r="2.5" />
      <circle cx="16.5" cy="8" r="2.2" />
      <path d="M4.7 17.5c.8-2.5 2.6-3.7 5.3-3.7s4.4 1.2 5.1 3.7" />
      <path d="M14.8 16.4c.4-1.6 1.6-2.6 3.6-2.6 1.1 0 2 .3 2.8.8" />
    </svg>
  );
}

export { TOP_BAR_HEIGHT };

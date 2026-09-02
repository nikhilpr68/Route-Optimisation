import React, { useEffect, useRef, useState } from 'react';

import {
  createTeam,
  getMe,
  getTeam,
  joinTeamByCode,
  listProjects,
  listTeams,
  postCollaborateMessage,
  removeTeamMember,
  shareCollaborateProject,
} from '../../api/api';

import './CollaboratePage.css';

function formatFriendlyDate(value) {
  if (!value) return 'No date';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No date';
  return new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(date);
}

function formatFriendlyDateTime(value) {
  if (!value) return 'No time';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No time';
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function buildSummary(team) {
  if (!team) return null;
  const assignments = Array.isArray(team.assignments) ? team.assignments : [];
  const messages = Array.isArray(team.messages) ? team.messages : [];
  return {
    _id: team._id,
    name: team.name,
    description: team.description,
    joinCode: team.joinCode,
    createdAt: team.createdAt,
    updatedAt: team.updatedAt,
    createdBy: team.createdBy,
    memberCount: team.memberCount ?? (Array.isArray(team.members) ? team.members.length : 0),
    assignmentCount: team.assignmentCount ?? assignments.length,
    sharedProjectCount: team.sharedProjectCount ?? (Array.isArray(team.sharedProjects) ? team.sharedProjects.length : 0),
    messageCount: team.messageCount ?? messages.length,
    upcomingAssignmentCount: team.upcomingAssignmentCount ?? assignments.length,
    currentUserMembership: team.currentUserMembership || null,
    isAdmin: Boolean(team.isAdmin),
  };
}

function toApiError(error, fallback) {
  return error?.response?.data?.message || error?.message || fallback;
}

export default function CollaboratePage() {
  const [currentUser, setCurrentUser] = useState(null);
  const [teams, setTeams] = useState([]);
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [selectedTeam, setSelectedTeam] = useState(null);
  const [isBooting, setIsBooting] = useState(true);
  const [isRefreshingTeam, setIsRefreshingTeam] = useState(false);
  const [projects, setProjects] = useState([]);
  const [loadingProjects, setLoadingProjects] = useState(false);
  const [createForm, setCreateForm] = useState({ name: '', description: '' });
  const [joinCode, setJoinCode] = useState('');
  const [activeDialog, setActiveDialog] = useState('');
  const [isCurrentTeamMenuOpen, setIsCurrentTeamMenuOpen] = useState(false);
  const [teamContextMenu, setTeamContextMenu] = useState(null);
  const [isMembersOpen, setIsMembersOpen] = useState(false);
  const [sharedProjectId, setSharedProjectId] = useState('');
  const [chatDraft, setChatDraft] = useState('');
  const [notice, setNotice] = useState({ type: '', text: '' });
  const [busyAction, setBusyAction] = useState('');
  const chatListRef = useRef(null);
  const currentTeamMenuRef = useRef(null);
  const membersMenuRef = useRef(null);

  async function refreshTeams(preferredTeamId = selectedTeamId) {
    const response = await listTeams();
    const nextItems = Array.isArray(response?.items) ? response.items : [];
    setTeams(nextItems);

    const preferredStillExists = nextItems.find((team) => team._id === preferredTeamId);
    if (preferredStillExists) {
      setSelectedTeamId(preferredTeamId);
      return preferredTeamId;
    }

    const nextFirstTeamId = nextItems[0]?._id || '';
    setSelectedTeamId(nextFirstTeamId);
    if (!nextFirstTeamId) setSelectedTeam(null);
    return nextFirstTeamId;
  }

  function syncTeam(team, options = {}) {
    if (!team || !team._id) return;
    const shouldSelect = options.select !== false;
    setSelectedTeam(team);
    if (shouldSelect) setSelectedTeamId(team._id);
    setTeams((prev) => {
      const summary = buildSummary(team);
      const others = prev.filter((item) => item._id !== team._id);
      return [summary, ...others];
    });
  }

  function removeTeamFromState(teamId) {
    setTeams((prev) => prev.filter((item) => item._id !== teamId));
    setSelectedTeam((prev) => (prev?._id === teamId ? null : prev));
    setSelectedTeamId((prev) => (prev === teamId ? '' : prev));
  }

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      setIsBooting(true);
      try {
        const [me, nextTeamId] = await Promise.all([
          getMe(),
          refreshTeams(''),
        ]);
        if (cancelled) return;
        setCurrentUser(me || null);
        if (nextTeamId) {
          const team = await getTeam(nextTeamId);
          if (cancelled) return;
          setSelectedTeam(team);
        }
      } catch (error) {
        if (cancelled) return;
        setNotice({
          type: 'error',
          text: toApiError(error, 'Unable to load collaborate workspace right now.'),
        });
      } finally {
        if (!cancelled) setIsBooting(false);
      }
    }

    boot();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!selectedTeamId) return undefined;
    let cancelled = false;

    async function loadSelectedTeam() {
      setIsRefreshingTeam(true);
      try {
        const team = await getTeam(selectedTeamId);
        if (cancelled) return;
        setSelectedTeam(team);
        setTeams((prev) => {
          const summary = buildSummary(team);
          const next = prev.filter((item) => item._id !== team._id);
          return [summary, ...next];
        });
      } catch (error) {
        if (cancelled) return;
        if (error?.response?.status === 403 || error?.response?.status === 404) {
          removeTeamFromState(selectedTeamId);
          refreshTeams('');
          return;
        }
        setNotice({
          type: 'error',
          text: toApiError(error, 'Unable to load the selected team.'),
        });
      } finally {
        if (!cancelled) setIsRefreshingTeam(false);
      }
    }

    loadSelectedTeam();
    const intervalId = window.setInterval(loadSelectedTeam, 20000);
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [selectedTeamId]);

  useEffect(() => {
    if (!selectedTeam?.isAdmin) {
      setProjects([]);
      setSharedProjectId('');
      return;
    }
    let cancelled = false;

    async function loadProjects() {
      setLoadingProjects(true);
      try {
        const response = await listProjects({ forceRefresh: true });
        if (cancelled) return;
        const items = Array.isArray(response?.items) ? response.items : [];
        const runnable = items.filter((item) => {
          const state = String(item?.run?.state || '').toLowerCase();
          return state === 'done' || String(item?.status || '').toLowerCase() === 'completed';
        });
        setProjects(runnable);
      } catch (error) {
        if (cancelled) return;
        setNotice({
          type: 'error',
          text: toApiError(error, 'Unable to load projects for team sharing.'),
        });
      } finally {
        if (!cancelled) setLoadingProjects(false);
      }
    }

    loadProjects();
    return () => {
      cancelled = true;
    };
  }, [selectedTeam?.isAdmin]);

  useEffect(() => {
    if (!chatListRef.current) return;
    chatListRef.current.scrollTop = chatListRef.current.scrollHeight;
  }, [selectedTeam?.messages?.length]);

  useEffect(() => {
    if (!activeDialog) return undefined;
    const onKeyDown = (event) => {
      if (event.key === 'Escape') {
        setActiveDialog('');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [activeDialog]);

  useEffect(() => {
    const handlePointerDown = (event) => {
      if (currentTeamMenuRef.current && !currentTeamMenuRef.current.contains(event.target)) {
        setIsCurrentTeamMenuOpen(false);
        setTeamContextMenu(null);
      }
      if (membersMenuRef.current && !membersMenuRef.current.contains(event.target)) {
        setIsMembersOpen(false);
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => document.removeEventListener('pointerdown', handlePointerDown);
  }, []);

  const selectedTeamSummary = teams.find((team) => team._id === selectedTeamId) || null;
  const sharedProjects = Array.isArray(selectedTeam?.sharedProjects) ? selectedTeam.sharedProjects : [];
  const teamMembers = Array.isArray(selectedTeam?.members) ? selectedTeam.members : [];
  const messages = Array.isArray(selectedTeam?.messages) ? selectedTeam.messages : [];
  async function handleCreateTeam(event) {
    event.preventDefault();
    setBusyAction('create-team');
    setNotice({ type: '', text: '' });
    try {
      const team = await createTeam(createForm);
      syncTeam(team);
      setCreateForm({ name: '', description: '' });
      setActiveDialog('');
      setNotice({ type: 'success', text: 'Team created. Share the join code or add members directly.' });
    } catch (error) {
      setNotice({ type: 'error', text: toApiError(error, 'Unable to create the team.') });
    } finally {
      setBusyAction('');
    }
  }

  async function handleJoinTeam(event) {
    event.preventDefault();
    setBusyAction('join-team');
    setNotice({ type: '', text: '' });
    try {
      const team = await joinTeamByCode(joinCode);
      syncTeam(team);
      setJoinCode('');
      setActiveDialog('');
      setNotice({ type: 'success', text: 'You joined the team.' });
    } catch (error) {
      setNotice({ type: 'error', text: toApiError(error, 'Unable to join the team.') });
    } finally {
      setBusyAction('');
    }
  }

  async function handleCopyJoinCode() {
    if (!selectedTeam?.joinCode) return;
    try {
      await navigator.clipboard.writeText(selectedTeam.joinCode);
      setNotice({ type: 'success', text: `Copied team code ${selectedTeam.joinCode}.` });
    } catch {
      setNotice({ type: 'error', text: 'Could not copy the team code from this browser.' });
    }
  }

  async function handleLeaveTeam(teamId, teamName) {
    if (!teamId || !currentUser?._id) return;
    if (!window.confirm(`Leave ${teamName || 'this team'}?`)) return;

    setBusyAction(`leave-team-${teamId}`);
    setNotice({ type: '', text: '' });
    setTeamContextMenu(null);
    setIsCurrentTeamMenuOpen(false);
    try {
      const response = await removeTeamMember(teamId, currentUser._id);
      if (response?.removed) {
        removeTeamFromState(teamId);
        const nextTeamId = await refreshTeams('');
        if (nextTeamId) {
          const team = await getTeam(nextTeamId);
          setSelectedTeam(team);
        }
        setNotice({ type: 'success', text: `You left ${teamName || 'the team'}.` });
      }
    } catch (error) {
      setNotice({ type: 'error', text: toApiError(error, 'Unable to leave that team.') });
    } finally {
      setBusyAction('');
    }
  }

  async function handleShareProject(event) {
    event.preventDefault();
    if (!selectedTeam?._id) return;
    if (!sharedProjectId) return;

    setBusyAction('share-project');
    setNotice({ type: '', text: '' });
    try {
      const team = await shareCollaborateProject(selectedTeam._id, sharedProjectId);
      syncTeam(team, { select: false });
      setSharedProjectId('');
      setNotice({ type: 'success', text: 'Project shared with the team.' });
    } catch (error) {
      setNotice({ type: 'error', text: toApiError(error, 'Unable to share that project.') });
    } finally {
      setBusyAction('');
    }
  }

  async function handleSendMessage(event) {
    event.preventDefault();
    if (!selectedTeam?._id) return;
    if (!normalizeText(chatDraft)) return;

    setBusyAction('send-message');
    setNotice({ type: '', text: '' });
    try {
      const team = await postCollaborateMessage(selectedTeam._id, chatDraft);
      syncTeam(team, { select: false });
      setChatDraft('');
    } catch (error) {
      setNotice({ type: 'error', text: toApiError(error, 'Unable to send the message.') });
    } finally {
      setBusyAction('');
    }
  }

  if (isBooting) {
    return (
      <div className="collab-page">
        <div className="collab-card collab-empty">Loading collaborate workspace...</div>
      </div>
    );
  }

  return (
    <div className="collab-page">
      <div className="collab-stack">
        <section className="collab-hero">
          <div className="collab-hero-bar">
            <div className="collab-hero-left">
              <div className="collab-title-wrap">
                <h1 className="collab-title collab-title-trigger">Collaborate</h1>
                <div className="collab-title-tooltip" role="note">
                  Create transport teams, assign drivers and employees to fixed routes, and keep each member aligned on timing, vehicle responsibility, and route links.
                </div>
              </div>
              <button type="button" className="collab-ghost-button" onClick={() => setActiveDialog('create')}>
                Create Team
              </button>
              <button type="button" className="collab-ghost-button" onClick={() => setActiveDialog('join')}>
                Join Team
              </button>
            </div>
            {teams.length ? (
              <div className="collab-current-team" ref={currentTeamMenuRef}>
                <span className="collab-current-team-label">Current Team</span>
                <button
                  type="button"
                  className="collab-current-team-trigger"
                  onClick={() => {
                    setIsCurrentTeamMenuOpen((prev) => !prev);
                    setTeamContextMenu(null);
                  }}
                >
                  <span>{selectedTeamSummary?.name || selectedTeam?.name || 'Select team'}</span>
                  <span className={`collab-current-team-caret ${isCurrentTeamMenuOpen ? 'is-open' : ''}`}>v</span>
                </button>
                {isCurrentTeamMenuOpen ? (
                  <div className="collab-current-team-menu">
                    {teams.map((team) => (
                      <button
                        key={team._id}
                        type="button"
                        className={`collab-current-team-item ${selectedTeamId === team._id ? 'is-active' : ''}`}
                        onClick={() => {
                          setSelectedTeamId(team._id);
                          setIsCurrentTeamMenuOpen(false);
                          setTeamContextMenu(null);
                        }}
                        onContextMenu={(event) => {
                          event.preventDefault();
                          setTeamContextMenu({ teamId: team._id, teamName: team.name });
                        }}
                      >
                        <span>{team.name}</span>
                        {selectedTeamId === team._id ? <span className="collab-current-team-check">Current</span> : null}
                      </button>
                    ))}
                    {teamContextMenu ? (
                      <div className="collab-current-team-context">
                        <button
                          type="button"
                          className="collab-current-team-context-item"
                          onClick={() => handleLeaveTeam(teamContextMenu.teamId, teamContextMenu.teamName)}
                          disabled={busyAction === `leave-team-${teamContextMenu.teamId}`}
                        >
                          {busyAction === `leave-team-${teamContextMenu.teamId}` ? 'Leaving...' : `Leave ${teamContextMenu.teamName}`}
                        </button>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>

          {notice.text ? (
            <div className={notice.type === 'error' ? 'collab-error' : 'collab-success'}>
              {notice.text}
            </div>
          ) : null}

        </section>

        <div className="collab-stack collab-main">
          {!selectedTeam ? (
            <section className="collab-card collab-empty">
              {teams.length ? 'Pick a current team from the header to see member roles, chat, and route assignments.' : 'No teams yet. Create one above or join a team with its unique code.'}
            </section>
          ) : (
            <div className="collab-layout">
              <div className="collab-layout-left">
                <section className="collab-card collab-chat-panel">
                  <h2 className="collab-section-title">Team Chat</h2>

                  <div className="collab-message-list" ref={chatListRef}>
                    {messages.length ? (
                      messages.map((message) => (
                        <article
                          key={message._id || `${message.createdAt}-${message.sender?._id}`}
                          className={`collab-message ${message.isMine ? 'is-mine' : ''}`}
                        >
                          <div className="collab-message-header">
                            <span>{message.sender?.name || message.sender?.email || 'Member'}</span>
                            <span>{formatFriendlyDateTime(message.createdAt)}</span>
                          </div>
                          <p>{message.text}</p>
                        </article>
                      ))
                    ) : (
                      <div className="collab-empty">
                        No messages yet. Start with route updates, shift reminders, or driver handoff details.
                      </div>
                    )}
                  </div>

                  <form className="collab-chat-composer" onSubmit={handleSendMessage}>
                    <div className="collab-chat-input-shell">
                      <input
                        className="collab-chat-input"
                        type="text"
                        placeholder="Write to the team..."
                        value={chatDraft}
                        onChange={(event) => setChatDraft(event.target.value)}
                      />
                    </div>
                  </form>
                </section>
              </div>

              <div className="collab-layout-right">
                <section className="collab-card">
                  <div className="collab-space-between">
                    <div>
                      <div className="collab-team-heading" ref={membersMenuRef}>
                        <h2 className="collab-title" style={{ fontSize: '1.45rem' }}>{selectedTeam.name}</h2>
                        <button
                          type="button"
                          className="collab-member-count-trigger"
                          onClick={() => setIsMembersOpen((prev) => !prev)}
                        >
                          {selectedTeam.memberCount} Members
                        </button>
                        {isMembersOpen ? (
                          <div className="collab-member-popover">
                            {teamMembers.length ? (
                              teamMembers.map((member) => (
                                <div key={member?.user?._id || member?.user?.email} className="collab-member-popover-item">
                                  <span>{member?.user?.name || member?.user?.email || 'Unknown user'}</span>
                                  {member?.isCurrentUser ? <span className="collab-member-popover-tag">You</span> : null}
                                </div>
                              ))
                            ) : (
                              <div className="collab-member-popover-empty">No members yet.</div>
                            )}
                          </div>
                        ) : null}
                      </div>
                      <p className="collab-subtitle">
                        {selectedTeam.description || 'Use this team to coordinate routes, shifts, and live conversation.'}
                      </p>
                    </div>
                    <div className="collab-meta">
                      <span className="collab-pill is-highlight">Code {selectedTeam.joinCode}</span>
                    </div>
                  </div>
                </section>

                <section className="collab-card">
                  <h2 className="collab-section-title">Shared Projects</h2>

                  {selectedTeam.isAdmin ? (
                    <form className="collab-stack" style={{ marginBottom: 16 }} onSubmit={handleShareProject}>
                      <div className="collab-grid-2">
                        <select
                          className="collab-select"
                          value={sharedProjectId}
                          onChange={(event) => setSharedProjectId(event.target.value)}
                        >
                          <option value="">Select project to share</option>
                          {projects.map((project) => (
                            <option key={project._id} value={project._id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                        <button
                          className="collab-button"
                          type="submit"
                          disabled={!sharedProjectId || busyAction === 'share-project' || loadingProjects}
                        >
                          {busyAction === 'share-project' ? 'Sharing...' : 'Share Project'}
                        </button>
                      </div>
                      {loadingProjects ? <div className="collab-note">Loading shareable projects...</div> : null}
                    </form>
                  ) : null}

                  {sharedProjects.length ? (
                    <div className="collab-assignment-list">
                      {sharedProjects.map((project) => (
                        <article key={project._id || project.projectId} className="collab-assignment-card">
                          <div className="collab-space-between">
                            <div>
                              <h3>{project.name || 'Untitled project'}</h3>
                              <div className="collab-meta" style={{ marginTop: 10 }}>
                                {project.status ? <span className="collab-pill is-cool">{project.status}</span> : null}
                                <span className="collab-pill is-highlight">Shared {formatFriendlyDateTime(project.sharedAt)}</span>
                              </div>
                            </div>
                            {project.projectId ? (
                              <a
                                href={`/projects/${project.projectId}/results`}
                                className="collab-link-button"
                              >
                                Open Project
                              </a>
                            ) : null}
                          </div>

                          <div className="collab-assignment-grid" style={{ marginTop: 14 }}>
                            <div className="collab-card">
                              <div className="collab-kv">
                                <span className="collab-kv-label">Shared By</span>
                                <span className="collab-kv-value">{project.sharedBy?.name || project.sharedBy?.email || 'Unknown user'}</span>
                              </div>
                            </div>
                            <div className="collab-card">
                              <div className="collab-kv">
                                <span className="collab-kv-label">Project Created</span>
                                <span className="collab-kv-value">{formatFriendlyDate(project.projectCreatedAt)}</span>
                              </div>
                            </div>
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <div className="collab-empty">
                      No projects have been shared with this team yet.
                    </div>
                  )}
                </section>
              </div>
            </div>
          )}
        </div>
      </div>

      {activeDialog ? (
        <div className="collab-modal-backdrop" onClick={() => setActiveDialog('')}>
          <div
            className="collab-modal"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
          >
            <div className="collab-space-between">
              <h2 className="collab-section-title" style={{ marginBottom: 0 }}>
                {activeDialog === 'create' ? 'Create Team' : 'Join Team'}
              </h2>
              <button type="button" className="collab-modal-close" onClick={() => setActiveDialog('')} aria-label="Close dialog">
                x
              </button>
            </div>

            {activeDialog === 'create' ? (
              <form className="collab-stack" onSubmit={handleCreateTeam}>
                <input
                  className="collab-input"
                  type="text"
                  placeholder="Team name"
                  value={createForm.name}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, name: event.target.value }))}
                />
                <textarea
                  className="collab-textarea"
                  placeholder="Optional team description"
                  value={createForm.description}
                  onChange={(event) => setCreateForm((prev) => ({ ...prev, description: event.target.value }))}
                />
                <button className="collab-button" type="submit" disabled={busyAction === 'create-team'}>
                  {busyAction === 'create-team' ? 'Creating...' : 'Create Team'}
                </button>
              </form>
            ) : (
              <form className="collab-stack" onSubmit={handleJoinTeam}>
                <input
                  className="collab-input"
                  type="text"
                  placeholder="Enter team code"
                  value={joinCode}
                  onChange={(event) => setJoinCode(event.target.value.toUpperCase())}
                />
                <div className="collab-note">
                  Use the unique team code to join another admin&apos;s team while keeping your own teams and assignments intact.
                </div>
                <button className="collab-ghost-button" type="submit" disabled={busyAction === 'join-team'}>
                  {busyAction === 'join-team' ? 'Joining...' : 'Join Team'}
                </button>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

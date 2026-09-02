import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { HELP_TOPICS } from './helpTopics';

const HelpSupportPage = () => {
  const [query, setQuery] = useState('');
  const navigate = useNavigate();

  const filteredTopics = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return HELP_TOPICS;
    return HELP_TOPICS.filter((topic) => topic.title.toLowerCase().includes(q));
  }, [query]);

  const handleSearch = () => {
    if (!filteredTopics.length) return;
    navigate(`/help-support/${filteredTopics[0].slug}`);
  };

  return (
    <div style={{ padding: '24px 16px 24px 8px', maxWidth: '1200px', margin: '0 auto' }}>
      <div
        className="glass-morphism reflective-card-container"
        style={{ padding: '20px', borderRadius: '18px', marginBottom: '16px' }}
      >
        <h1 style={{ margin: 0, fontSize: '2rem', fontWeight: 750 }}>Help & Support</h1>
        <p style={{ margin: '10px 0 0 0', opacity: 0.82, fontSize: '0.98rem', lineHeight: 1.5 }}>
          Search support topics or raise an issue. We promise to provide help within 24 hours.
        </p>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1.45fr 0.9fr',
          gap: '16px',
          alignItems: 'start'
        }}
      >
        <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
          <div style={{ display: 'flex', gap: '0', marginBottom: '18px' }}>
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search questions, keywords, topics"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSearch();
              }}
              style={{
                flex: 1,
                height: '46px',
                borderTopLeftRadius: '12px',
                borderBottomLeftRadius: '12px',
                border: '1px solid rgba(255,255,255,0.18)',
                borderRight: 'none',
                background: 'rgba(255,255,255,0.07)',
                color: 'white',
                padding: '0 14px',
                fontSize: '0.95rem',
                outline: 'none'
              }}
            />
            <button
              type="button"
              onClick={handleSearch}
              style={{
                height: '46px',
                minWidth: '118px',
                borderTopRightRadius: '12px',
                borderBottomRightRadius: '12px',
                border: '1px solid rgba(255,255,255,0.22)',
                background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                color: 'white',
                fontWeight: 700,
                fontSize: '0.92rem',
                cursor: 'pointer'
              }}
            >
              Search
            </button>
          </div>

          <h2 style={{ margin: '0 0 10px 0', fontSize: '1.45rem', fontWeight: 720 }}>All topics</h2>
          <div style={{ display: 'grid' }}>
            {filteredTopics.map((topic) => (
              <button
                type="button"
                key={topic.slug}
                onClick={() => navigate(`/help-support/${topic.slug}`)}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  textAlign: 'left',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '1px solid rgba(255,255,255,0.1)',
                  color: 'white',
                  padding: '14px 2px',
                  cursor: 'pointer',
                  fontSize: '1rem'
                }}
              >
                <span>{topic.title}</span>
                <span style={{ opacity: 0.55, fontSize: '1.2rem' }}>{">"}</span>
              </button>
            ))}
            {filteredTopics.length === 0 ? (
              <div style={{ opacity: 0.72, padding: '12px 2px' }}>No matching topics found.</div>
            ) : null}
          </div>
        </div>

        <div style={{ display: 'grid', gap: '16px' }}>
          <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
            <h3 style={{ margin: 0, fontSize: '1.06rem', fontWeight: 700 }}>24-hour support promise</h3>
            <p style={{ margin: '10px 0 0 0', opacity: 0.82, fontSize: '0.92rem', lineHeight: 1.5 }}>
              Our team reviews every request and responds within 24 hours.
            </p>
          </div>
          <div className="glass-morphism reflective-card-container" style={{ padding: '18px' }}>
            <h3 style={{ margin: 0, fontSize: '1.06rem', fontWeight: 700 }}>Contact support</h3>
            <p style={{ margin: '10px 0 0 0', opacity: 0.82, fontSize: '0.92rem', lineHeight: 1.5 }}>
              Email: support@velora.ai
            </p>
            <p style={{ margin: '6px 0 0 0', opacity: 0.82, fontSize: '0.92rem', lineHeight: 1.5 }}>
              Include run ID, issue summary, and screenshots for faster resolution.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};

export default HelpSupportPage;

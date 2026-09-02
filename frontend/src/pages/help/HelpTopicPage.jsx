import React from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { HELP_TOPIC_MAP } from './helpTopics';

const HelpTopicPage = () => {
  const { topicSlug } = useParams();
  const topic = HELP_TOPIC_MAP[topicSlug];

  if (!topic) return <Navigate to="/help-support" replace />;

  return (
    <div style={{ padding: '24px 16px 24px 8px', maxWidth: '980px', margin: '0 auto' }}>
      <div className="glass-morphism reflective-card-container" style={{ padding: '20px', marginBottom: '16px' }}>
        <Link
          to="/help-support"
          style={{
            color: '#93c5fd',
            textDecoration: 'none',
            fontSize: '0.9rem',
            fontWeight: 700
          }}
        >
          {"<- Back to all topics"}
        </Link>
        <h1 style={{ margin: '10px 0 0 0', fontSize: '1.9rem', fontWeight: 750 }}>{topic.title}</h1>
        <p style={{ margin: '10px 0 0 0', opacity: 0.86, lineHeight: 1.55 }}>{topic.summary}</p>
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '20px', marginBottom: '16px' }}>
        <h2 style={{ margin: 0, fontSize: '1.2rem' }}>Common questions</h2>
        <div style={{ marginTop: '12px', display: 'grid', gap: '10px' }}>
          {topic.faqs.map((faq) => (
            <div
              key={faq}
              style={{
                border: '1px solid rgba(255,255,255,0.14)',
                borderRadius: '10px',
                background: 'rgba(255,255,255,0.04)',
                padding: '12px 14px',
                fontSize: '0.96rem'
              }}
            >
              {faq}
            </div>
          ))}
        </div>
      </div>

      <div className="glass-morphism reflective-card-container" style={{ padding: '20px' }}>
        <h2 style={{ margin: 0, fontSize: '1.08rem' }}>Need more help?</h2>
        <p style={{ margin: '10px 0 0 0', opacity: 0.86, lineHeight: 1.55 }}>
          Raise a support request with your run ID and screenshots. We promise a response within 24 hours.
        </p>
      </div>
    </div>
  );
};

export default HelpTopicPage;

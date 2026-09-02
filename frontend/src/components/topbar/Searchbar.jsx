import React from 'react';

const Searchbar = ({ value, onChange, onSearch }) => {
  const SearchIcon = () => (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="white"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );

  return (
    <div style={{ flex: 1, display: 'flex', justifyContent: 'center', position: 'relative' }}>
      <div style={{ width: '400px', position: 'relative' }}>
        <input
          type="text"
          placeholder="Search projects..."
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              onSearch(value);
            }
          }}
          style={{
            width: '100%',
            padding: '10px 15px',
            borderRadius: '20px',
            border: 'none',
            backgroundColor: 'rgba(255,255,255,0.15)',
            color: 'white',
            outline: 'none',
            backdropFilter: 'blur(5px)',
          }}
        />

        <span
          style={{
            position: 'absolute',
            right: '15px',
            top: '10px',
            opacity: 0.7,
            pointerEvents: 'none',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <SearchIcon />
        </span>
      </div>
    </div>
  );
};

export default Searchbar;

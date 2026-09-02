import React, { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  changePassword,
  getMe,
  logout as clearAuth,
  updateMe
} from '../../api/api';
import ImageCropModal from '../../components/user/ImageCropModal';
import UserAvatar from '../../components/user/UserAvatar';

const fieldStyle = {
  width: '100%',
  height: '42px',
  borderRadius: '10px',
  border: '1px solid rgba(255,255,255,0.2)',
  background: 'rgba(10,14,28,0.62)',
  color: 'white',
  padding: '0 12px',
  fontSize: '0.9rem',
  outline: 'none'
};

const PASSWORD_STRENGTH_HINT =
  'Password must be at least 8 characters and include uppercase, lowercase, number, and special character.';
const PROFILE_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const PROFILE_IMAGE_ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

function getPasswordStrengthError(rawPassword) {
  const password = String(rawPassword || '');
  if (password.length < 8) return PASSWORD_STRENGTH_HINT;
  if (!/[A-Z]/.test(password)) return PASSWORD_STRENGTH_HINT;
  if (!/[a-z]/.test(password)) return PASSWORD_STRENGTH_HINT;
  if (!/[0-9]/.test(password)) return PASSWORD_STRENGTH_HINT;
  if (!/[^A-Za-z0-9]/.test(password)) return PASSWORD_STRENGTH_HINT;
  return '';
}

const SettingsPage = () => {
  const navigate = useNavigate();
  const [user, setUser] = useState({
    name: '',
    email: '',
    profileImage: '',
  });
  const [draftName, setDraftName] = useState('');
  const [draftEmail, setDraftEmail] = useState('');
  const [draftProfileImage, setDraftProfileImage] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [showPasswordPanel, setShowPasswordPanel] = useState(false);
  const [savingProfile, setSavingProfile] = useState(false);
  const [cropSource, setCropSource] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    let mounted = true;
    const load = async () => {
      try {
        const me = await getMe();
        if (!mounted) return;
        setUser({
          name: me?.name || '',
          email: me?.email || '',
          profileImage: me?.profileImage || '',
        });
        setDraftName(me?.name || '');
        setDraftEmail(me?.email || '');
        setDraftProfileImage(me?.profileImage || '');
      } catch (_) {
        if (!mounted) return;
        setUser({
          name: '',
          email: '',
          profileImage: '',
        });
        setDraftName('');
        setDraftEmail('');
        setDraftProfileImage('');
      }
    };
    load();
    return () => {
      mounted = false;
    };
  }, []);

  const handleReset = () => {
    setDraftName(user.name || '');
    setDraftEmail(user.email || '');
    setDraftProfileImage(user.profileImage || '');
    setCropSource(null);
  };

  const handlePickProfileImage = () => {
    fileInputRef.current?.click();
  };

  const handleProfileImageChange = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    if (!PROFILE_IMAGE_ACCEPT.split(',').includes(file.type)) {
      alert('Please choose a PNG, JPEG, WEBP, or GIF image.');
      return;
    }

    if (file.size > PROFILE_IMAGE_MAX_BYTES) {
      alert('Profile image must be 5MB or smaller.');
      return;
    }

    try {
      const nextImage = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(new Error('Unable to read the selected image.'));
        reader.readAsDataURL(file);
      });
      setCropSource({
        src: nextImage,
        mimeType: file.type
      });
    } catch (err) {
      alert(err.message || 'Unable to read the selected image.');
    }
  };

  const handleRemoveProfileImage = () => {
    setDraftProfileImage('');
    setCropSource(null);
  };

  const handleCancelCrop = () => {
    setCropSource(null);
  };

  const handleApplyCrop = (croppedImage) => {
    setDraftProfileImage(croppedImage);
    setCropSource(null);
  };

  const handleSave = async () => {
    const nextName = draftName.trim();
    const nextEmail = draftEmail.trim().toLowerCase();

    if (!nextName || !nextEmail) {
      alert('Name and email are required.');
      return;
    }

    setSavingProfile(true);
    try {
      const updated = await updateMe({ name: nextName, email: nextEmail, profileImage: draftProfileImage });
      const nextUser = {
        name: updated?.name || nextName,
        email: updated?.email || nextEmail,
        profileImage: updated?.profileImage || '',
      };
      setUser(nextUser);
      setDraftName(nextUser.name);
      setDraftEmail(nextUser.email);
      setDraftProfileImage(nextUser.profileImage);
      window.dispatchEvent(new CustomEvent('profile-updated', { detail: nextUser }));
      alert('Account settings saved successfully.');
    } catch (err) {
      alert('Failed to save account settings: ' + (err.response?.data?.message || err.message));
    } finally {
      setSavingProfile(false);
    }
  };

  const handleLogout = () => {
    clearAuth();
    navigate('/', { replace: true });
  };

  const handleChangePassword = async () => {
    if (!currentPassword || !newPassword || !confirmPassword) {
      alert('Please fill all password fields.');
      return;
    }
    const passwordError = getPasswordStrengthError(newPassword);
    if (passwordError) {
      alert(passwordError);
      return;
    }
    if (newPassword !== confirmPassword) {
      alert('New password and confirm password do not match.');
      return;
    }

    setChangingPassword(true);
    try {
      const response = await changePassword(currentPassword, newPassword);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setShowPasswordPanel(false);
      alert(response?.message || 'Password changed successfully.');
    } catch (err) {
      alert('Failed to change password: ' + (err.response?.data?.message || err.message));
    } finally {
      setChangingPassword(false);
    }
  };

  const handleCancelPasswordChange = () => {
    setShowPasswordPanel(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmPassword('');
  };

  return (
    <div style={{ padding: '24px 16px 24px 8px', maxWidth: '1100px', margin: '0 auto' }}>
      {cropSource ? (
        <ImageCropModal
          source={cropSource}
          onCancel={handleCancelCrop}
          onApply={handleApplyCrop}
        />
      ) : null}

      <div className="glass-morphism reflective-card-container" style={{ padding: '22px', marginBottom: '16px' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px', flexWrap: 'wrap' }}>
          <div>
            <h1 style={{ margin: 0, fontSize: '1.8rem', fontWeight: 700 }}>Settings</h1>
            <p style={{ margin: '8px 0 0 0', opacity: 0.7, fontSize: '0.92rem' }}>
              Manage account and app preferences.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" onClick={() => navigate('/home')} style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}>Home</button>
            <button type="button" onClick={() => navigate('/help-support')} style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}>Help & Support</button>
            <button
              type="button"
              onClick={handleLogout}
              style={{
                ...fieldStyle,
                width: 'auto',
                height: '38px',
                cursor: 'pointer',
                borderColor: 'rgba(248,113,113,0.45)',
                color: '#fca5a5'
              }}
            >
              Log Out
            </button>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '16px' }}>
        <div className="glass-morphism reflective-card-container" style={{ padding: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Account</h2>
          <div style={{ marginTop: '14px', display: 'grid', gap: '10px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '4px', flexWrap: 'wrap' }}>
              <UserAvatar user={{ name: draftName, email: draftEmail, profileImage: draftProfileImage }} size={72} fontSize="1.6rem" showRing />
              <div style={{ display: 'grid', gap: '8px' }}>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={PROFILE_IMAGE_ACCEPT}
                  onChange={handleProfileImageChange}
                  style={{ display: 'none' }}
                />
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button type="button" onClick={handlePickProfileImage} style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}>
                    Change Picture
                  </button>
                  <button type="button" onClick={handleRemoveProfileImage} style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}>
                    Remove Picture
                  </button>
                </div>
                <span style={{ fontSize: '0.78rem', opacity: 0.62 }}>
                  PNG, JPEG, WEBP, or GIF up to 5MB.
                </span>
              </div>
            </div>
            <label style={{ fontSize: '0.82rem', opacity: 0.75 }}>Full Name</label>
            <input style={fieldStyle} value={draftName} onChange={(e) => setDraftName(e.target.value)} />
            <label style={{ fontSize: '0.82rem', opacity: 0.75 }}>Email</label>
            <input style={fieldStyle} value={draftEmail} onChange={(e) => setDraftEmail(e.target.value)} />
            <div style={{ display: 'flex', gap: '8px', marginTop: '6px' }}>
              <button
                type="button"
                onClick={handleSave}
                disabled={savingProfile}
                style={{
                  height: '38px',
                  borderRadius: '10px',
                  border: '1px solid rgba(96,165,250,0.55)',
                  background: 'linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%)',
                  color: 'white',
                  fontWeight: 700,
                  padding: '0 14px',
                  cursor: savingProfile ? 'not-allowed' : 'pointer',
                  opacity: savingProfile ? 0.75 : 1
                }}
              >
                {savingProfile ? 'Saving...' : 'Save Changes'}
              </button>
              <button type="button" onClick={handleReset} style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}>
                Reset
              </button>
            </div>
          </div>
        </div>

        <div className="glass-morphism reflective-card-container" style={{ padding: '20px' }}>
          <h2 style={{ margin: 0, fontSize: '1.1rem' }}>Preferences</h2>
          <div style={{ marginTop: '14px', display: 'grid', gap: '12px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.9rem', opacity: 0.9 }}>Email notifications</span>
              <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>Coming soon</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.9rem', opacity: 0.9 }}>Default optimization intensity</span>
              <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>Coming soon</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: '0.9rem', opacity: 0.9 }}>Timezone</span>
              <span style={{ fontSize: '0.78rem', opacity: 0.6 }}>Coming soon</span>
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button
                type="button"
                onClick={() => {
                  if (showPasswordPanel) {
                    handleCancelPasswordChange();
                  } else {
                    setShowPasswordPanel(true);
                  }
                }}
                style={{
                  ...fieldStyle,
                  width: 'auto',
                  height: '38px',
                  cursor: 'pointer',
                  borderColor: 'rgba(96,165,250,0.45)'
                }}
              >
                {showPasswordPanel ? 'Hide Password Form' : 'Change Password'}
              </button>
              <button type="button" onClick={() => navigate('/help-support')} style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}>
                Contact Support
              </button>
            </div>
            {showPasswordPanel ? (
              <div style={{ marginTop: '8px', display: 'grid', gap: '8px' }}>
                <input
                  type="password"
                  placeholder="Current password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  style={fieldStyle}
                />
                <input
                  type="password"
                  placeholder="New password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  style={fieldStyle}
                />
                <input
                  type="password"
                  placeholder="Confirm new password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  style={fieldStyle}
                />
                <div style={{ fontSize: '0.8rem', opacity: 0.75 }}>
                  {PASSWORD_STRENGTH_HINT}
                </div>
                <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
                  <button
                    type="button"
                    onClick={handleChangePassword}
                    disabled={changingPassword}
                    style={{
                      ...fieldStyle,
                      width: 'auto',
                      height: '38px',
                      cursor: changingPassword ? 'not-allowed' : 'pointer',
                      borderColor: 'rgba(96,165,250,0.45)',
                      opacity: changingPassword ? 0.75 : 1
                    }}
                  >
                    {changingPassword ? 'Updating...' : 'Update Password'}
                  </button>
                  <button
                    type="button"
                    onClick={handleCancelPasswordChange}
                    style={{ ...fieldStyle, width: 'auto', height: '38px', cursor: 'pointer' }}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SettingsPage;

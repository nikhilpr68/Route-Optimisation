import React, { useState } from "react";
import { Routes, Route, Navigate, useLocation, useParams } from "react-router-dom";
import { AnimatePresence, motion } from "framer-motion";

import Dashboard from "./pages/dashboard/Dashboard";
import MetricsPage from "./pages/metrics/MetricsPage";
import Project_Dashboard from "./pages/projects/Project_Dashboard";
import ProjectWorkflowPage from "./pages/projects/ProjectWorkflowPage";
import SharedProjectPage from "./pages/projects/SharedProjectPage";
import CollaboratePage from "./pages/collaborate/CollaboratePage";
import SettingsPage from "./pages/settings/SettingsPage";
import HelpSupportPage from "./pages/help/HelpSupportPage";
import HelpTopicPage from "./pages/help/HelpTopicPage";
import Login from "./pages/auth/login";
import LandingPage from "./pages/landing/LandingPage";
import ValidatorPage from "./pages/validator/ValidatorPage";
import Sidebar from "./components/sidebar/SideBar";
import TopBar, { TOP_BAR_HEIGHT } from "./components/topbar/TopBar";

import "./App.css";

const HOME_PATH = "/home";

function RequireAuth({ children }) {
  const token = localStorage.getItem("token");
  const location = useLocation();
  if (!token) return <Navigate to="/" state={{ from: location }} replace />;
  return children;
}

function RequireGuest({ children }) {
  const token = localStorage.getItem("token");
  if (token) return <Navigate to={HOME_PATH} replace />;
  return children;
}

function ProjectDefaultRedirect() {
  const { id } = useParams();
  return <Navigate to={`/projects/${id}/map-view`} replace />;
}

function GuestPageTransition({ children, routeKey }) {
  return (
    <motion.div
      key={routeKey}
      initial={{ opacity: 0, y: 18, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -12, scale: 0.99 }}
      transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}
      style={{ minHeight: "100vh" }}
    >
      {children}
    </motion.div>
  );
}

function App() {
  const [scrollElement, setScrollElement] = useState(null);
  const location = useLocation();
  const hideTopBarRoutes = new Set(["/", "/login"]);
  const isSharedProjectRoute = /^\/shared\/projects\/[^/]+(?:\/[^/]+)?$/.test(location.pathname);
  const shouldShowTopBar = !hideTopBarRoutes.has(location.pathname) && !isSharedProjectRoute;
  const guestRouteKey = location.pathname === "/login" ? `/login${location.search}` : location.pathname;
  const handleScrollElementRef = (node) => {
    setScrollElement(node || null);
  };

  return (
    <>
      {shouldShowTopBar ? <TopBar scrollElement={scrollElement} /> : null}
      <AnimatePresence mode="wait" initial={false}>
        <Routes location={location} key={location.pathname === "/login" ? guestRouteKey : location.pathname}>
          <Route
            path="/"
            element={
              <RequireGuest>
                <GuestPageTransition routeKey={guestRouteKey}>
                  <div style={{ paddingTop: 0 }}>
                    <LandingPage />
                  </div>
                </GuestPageTransition>
              </RequireGuest>
            }
          />

          <Route
            path="/login"
            element={
              <RequireGuest>
                <GuestPageTransition routeKey={guestRouteKey}>
                  <div style={{ paddingTop: 0 }}>
                    <Login />
                  </div>
                </GuestPageTransition>
              </RequireGuest>
            }
          />

          <Route
            path="/shared/projects/:token/:section"
            element={
              <div style={{ paddingTop: 0, minHeight: "100vh", background: "#000000" }}>
                <SharedProjectPage />
              </div>
            }
          />

          <Route
            path="*"
            element={
              <RequireAuth>
                <div className="app-container">
                  <Sidebar />
                  <div
                    ref={handleScrollElementRef}
                    style={{
                      position: "relative",
                      zIndex: 1,
                      height: "100vh",
                      overflowY: "auto",
                      paddingLeft: "70px",
                      paddingTop: `${TOP_BAR_HEIGHT}px`,
                      background: "#000000",
                    }}
                  >
                    <Routes>
                      <Route path={HOME_PATH} element={<Dashboard />} />
                      <Route path="/collaborate" element={<CollaboratePage />} />
                      <Route path="/metrics" element={<MetricsPage />} />
                      <Route path="/validator" element={<ValidatorPage />} />
                      <Route path="/settings" element={<SettingsPage />} />
                      <Route path="/help-support" element={<HelpSupportPage />} />
                      <Route path="/help-support/:topicSlug" element={<HelpTopicPage />} />
                      <Route path="/projects/:id" element={<ProjectDefaultRedirect />} />
                      <Route path="/projects/:id/results" element={<Project_Dashboard />} />
                      <Route path="/projects/:id/:section" element={<ProjectWorkflowPage />} />
                      <Route path="*" element={<Navigate to={HOME_PATH} replace />} />
                    </Routes>
                  </div>
                </div>
              </RequireAuth>
            }
          />
        </Routes>
      </AnimatePresence>
    </>
  );
}

export default App;

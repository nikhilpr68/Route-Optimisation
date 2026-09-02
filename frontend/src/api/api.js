import api from "./client";

const PROJECT_LIST_CACHE_TTL_MS = 30 * 1000;

let projectsCache = {
    savedAt: 0,
    data: null,
    promise: null,
};

function readCachedProjects() {
    if (!projectsCache.data) return null;
    if ((Date.now() - projectsCache.savedAt) > PROJECT_LIST_CACHE_TTL_MS) return null;
    return projectsCache.data;
}

function writeCachedProjects(data) {
    projectsCache = {
        savedAt: Date.now(),
        data,
        promise: null,
    };
    return data;
}

export function invalidateProjectsCache() {
    projectsCache = {
        savedAt: 0,
        data: null,
        promise: null,
    };
}

function buildRunOptionsPayload(options = {}) {
    const payload = {};
    for (const key of [
        "optimizationIntensity",
        "customMaxRunSeconds",
        "customGenerations",
        "distanceMetric",
        "preferenceRelaxation",
        "computeTier",
        "runDate",
    ]) {
        if (options[key] !== undefined) {
            payload[key] = options[key];
        }
    }
    return payload;
}

// Auth
export async function login(email, password) {
    const { data } = await api.post("/api/auth/login", { email, password });
    if (data.token) localStorage.setItem("token", data.token);
    return data;
}

export async function register(name, email, password) {
    const { data } = await api.post("/api/auth/register", { name, email, password });
    if (data.token) localStorage.setItem("token", data.token);
    return data;
}

export async function googleAuth(idToken) {
    const { data } = await api.post("/api/auth/google", { idToken });
    if (data.token) localStorage.setItem("token", data.token);
    return data;
}

export function logout() {
    localStorage.removeItem("token");
}

export async function getMe() {
    const { data } = await api.get("/api/auth/me");
    return data;
}

export async function updateMe(payload) {
    const { data } = await api.put("/api/auth/me", payload);
    return data;
}

export async function changePassword(currentPassword, newPassword) {
    const { data } = await api.post("/api/auth/change-password", {
        currentPassword,
        newPassword
    });
    return data;
}

export async function forgotPassword(email, newPassword) {
    const { data } = await api.post("/api/auth/forgot-password", {
        email,
        newPassword
    });
    return data;
}

// Collaborate
export async function listTeams() {
    const { data } = await api.get("/api/collaborate");
    return data;
}

export async function createTeam(payload) {
    const { data } = await api.post("/api/collaborate", payload);
    return data;
}

export async function joinTeamByCode(joinCode) {
    const { data } = await api.post("/api/collaborate/join", { joinCode });
    return data;
}

export async function getTeam(teamId) {
    const { data } = await api.get(`/api/collaborate/${teamId}`);
    return data;
}

export async function searchCollaborateUsers(query, teamId) {
    const { data } = await api.get("/api/collaborate/users/search", {
        params: {
            q: query,
            teamId
        }
    });
    return data;
}

export async function addTeamMember(teamId, payload) {
    const { data } = await api.post(`/api/collaborate/${teamId}/members`, payload);
    return data;
}

export async function updateTeamMember(teamId, userId, payload) {
    const { data } = await api.patch(`/api/collaborate/${teamId}/members/${userId}`, payload);
    return data;
}

export async function removeTeamMember(teamId, userId) {
    const { data } = await api.delete(`/api/collaborate/${teamId}/members/${userId}`);
    return data;
}

export async function createCollaborateAssignment(teamId, payload) {
    const { data } = await api.post(`/api/collaborate/${teamId}/assignments`, payload);
    return data;
}

export async function shareCollaborateProject(teamId, projectId) {
    const { data } = await api.post(`/api/collaborate/${teamId}/projects`, { projectId });
    return data;
}

export async function deleteCollaborateAssignment(teamId, assignmentId) {
    const { data } = await api.delete(`/api/collaborate/${teamId}/assignments/${assignmentId}`);
    return data;
}

export async function postCollaborateMessage(teamId, text) {
    const { data } = await api.post(`/api/collaborate/${teamId}/messages`, { text });
    return data;
}

// Dashboard
export async function getDashboardMetrics() {
    const { data } = await api.get("/api/dashboard/metrics");
    return data;
}

// Projects
export async function createProject(name) {
    const { data } = await api.post("/api/projects", { name });
    invalidateProjectsCache();
    return data;
}

export async function listProjects(options = {}) {
    const forceRefresh = Boolean(options?.forceRefresh);
    if (!forceRefresh) {
        const cached = readCachedProjects();
        if (cached) return cached;
        if (projectsCache.promise) return projectsCache.promise;
    }

    projectsCache.promise = api.get("/api/projects")
        .then(({ data }) => writeCachedProjects(data))
        .catch((error) => {
            projectsCache.promise = null;
            throw error;
        });

    return projectsCache.promise;
}

export async function getProject(id) {
    const { data } = await api.get(`/api/projects/${id}`);
    return data;
}

export async function deleteProject(id) {
    const { data } = await api.delete(`/api/projects/${id}`);
    invalidateProjectsCache();
    return data;
}

export async function bulkDeleteProjects(projectIds) {
    const { data } = await api.post("/api/projects/bulk-delete", { projectIds });
    invalidateProjectsCache();
    return data;
}

export async function renameProject(id, name) {
    const { data } = await api.put(`/api/projects/${id}`, { name });
    invalidateProjectsCache();
    return data;
}

export async function getProjectShare(id) {
    const { data } = await api.get(`/api/projects/${id}/share`);
    return data;
}

export async function createProjectShare(id) {
    const { data } = await api.post(`/api/projects/${id}/share`);
    return data;
}

export async function revokeProjectShare(id) {
    const { data } = await api.delete(`/api/projects/${id}/share`);
    return data;
}

export async function getSharedProject(token) {
    const { data } = await api.get(`/api/shared/projects/${token}`);
    return data;
}

// Pipeline
export async function ingestArtifacts(projectId, files, notes = "") {
    const fd = new FormData();
    for (const f of files) fd.append("files", f);
    if (notes) fd.append("notes", notes);

    const { data } = await api.post(`/api/projects/${projectId}/ingest`, fd);
    invalidateProjectsCache();
    return data;
}

export async function parseAndRun(projectId, options = {}) {
    const { data } = await api.post(
        `/api/projects/${projectId}/parse-and-run`,
        buildRunOptionsPayload(options)
    );
    invalidateProjectsCache();
    return data;
}

export async function parseOnly(projectId, options = {}) {
    const { data } = await api.post(
        `/api/projects/${projectId}/parse-only`,
        buildRunOptionsPayload(options)
    );
    invalidateProjectsCache();
    return data;
}

export async function runSolver(projectId, options = {}) {
    const { data } = await api.post(
        `/api/projects/${projectId}/run-solver`,
        buildRunOptionsPayload(options)
    );
    invalidateProjectsCache();
    return data;
}

export async function getResults(projectId) {
    const { data } = await api.get(`/api/projects/${projectId}/results`);
    return data;
}

export async function getCompareRuns(projectId) {
    const { data } = await api.get(`/api/projects/${projectId}/compare-runs`);
    return data;
}

export async function getParsedInput(projectId) {
    const { data } = await api.get(`/api/projects/${projectId}/input`);
    return data;
}

export async function startRunValidation(projectId) {
    const { data } = await api.post(`/api/projects/${projectId}/validate-run`);
    invalidateProjectsCache();
    return data;
}

export async function runStandaloneValidator({
    testcaseFile,
    resultFile,
    distanceMetric,
    preferenceRelaxation,
    optimizationIntensity,
    customMaxRunSeconds,
    customGenerations,
    compareWithEngine,
}) {
    const fd = new FormData();
    fd.append("testcase", testcaseFile);
    fd.append("result", resultFile);
    fd.append("distanceMetric", distanceMetric);
    fd.append("preferenceRelaxation", preferenceRelaxation);
    fd.append("optimizationIntensity", optimizationIntensity);
    if (customMaxRunSeconds !== undefined && customMaxRunSeconds !== null && customMaxRunSeconds !== "") {
        fd.append("customMaxRunSeconds", String(customMaxRunSeconds));
    }
    if (customGenerations !== undefined && customGenerations !== null && customGenerations !== "") {
        fd.append("customGenerations", String(customGenerations));
    }
    fd.append("compareWithEngine", compareWithEngine ? "true" : "false");
    const candidatePaths = [
        "/api/validator/run",
        "/api/validators/run",
        "/api/validate/run",
    ];
    let lastError = null;
    for (const path of candidatePaths) {
        try {
            const { data } = await api.post(path, fd);
            return data;
        } catch (err) {
            const status = err?.response?.status;
            if (status === 404) {
                lastError = err;
                continue;
            }
            throw err;
        }
    }
    throw lastError || new Error("Validator API endpoint not found");
}

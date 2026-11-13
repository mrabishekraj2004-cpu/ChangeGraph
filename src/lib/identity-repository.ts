import type * as Sqlite from "./db";

type IdentityStorage = Pick<typeof Sqlite,
  | "createSession"
  | "findSession"
  | "getUserWorkspaces"
  | "removeSession"
  | "switchSessionWorkspace"
  | "getUserByEmail"
  | "getWorkspaceForUser"
  | "createUser"
  | "createEmailToken"
  | "consumeEmailToken"
  | "markTokenUsed"
  | "markUserVerified"
  | "updatePassword"
  | "updateUserName"
  | "recordAuditEvent"
  | "listWorkspaceMembers"
  | "listAuditEvents"
  | "addWorkspaceMember"
  | "updateWorkspaceMemberRole"
  | "removeWorkspaceMember"
  | "updateWorkspace"
  | "createWorkspace"
>;

type AsyncMethods<T> = {
  [Key in keyof T]: T[Key] extends (...args: infer Args) => infer Result
    ? (...args: Args) => Promise<Awaited<Result>>
    : never;
};

export type IdentityStore = AsyncMethods<IdentityStorage>;
export type IdentityRepository = IdentityStore;

async function loadSqliteIdentityStore(): Promise<IdentityStore> {
  const database = await import("./db");
  return {
    createSession: async (...args) => database.createSession(...args),
    findSession: async (...args) => database.findSession(...args),
    getUserWorkspaces: async (...args) => database.getUserWorkspaces(...args),
    removeSession: async (...args) => database.removeSession(...args),
    switchSessionWorkspace: async (...args) => database.switchSessionWorkspace(...args),
    getUserByEmail: async (...args) => database.getUserByEmail(...args),
    getWorkspaceForUser: async (...args) => database.getWorkspaceForUser(...args),
    createUser: async (...args) => database.createUser(...args),
    createEmailToken: async (...args) => database.createEmailToken(...args),
    consumeEmailToken: async (...args) => database.consumeEmailToken(...args),
    markTokenUsed: async (...args) => database.markTokenUsed(...args),
    markUserVerified: async (...args) => database.markUserVerified(...args),
    updatePassword: async (...args) => database.updatePassword(...args),
    updateUserName: async (...args) => database.updateUserName(...args),
    recordAuditEvent: async (...args) => database.recordAuditEvent(...args),
    listWorkspaceMembers: async (...args) => database.listWorkspaceMembers(...args),
    listAuditEvents: async (...args) => database.listAuditEvents(...args),
    addWorkspaceMember: async (...args) => database.addWorkspaceMember(...args),
    updateWorkspaceMemberRole: async (...args) => database.updateWorkspaceMemberRole(...args),
    removeWorkspaceMember: async (...args) => database.removeWorkspaceMember(...args),
    updateWorkspace: async (...args) => database.updateWorkspace(...args),
    createWorkspace: async (...args) => database.createWorkspace(...args),
  };
}

async function loadPostgresIdentityStore(connectionString: string): Promise<IdentityStore> {
  const { createPostgresPool, runPostgresIdentityMigrations, createPostgresIdentityStore } = await import("./postgres-identity-store");
  const pool = createPostgresPool(connectionString);
  try {
    await runPostgresIdentityMigrations(pool);
    return createPostgresIdentityStore(pool);
  } catch (error) {
    await pool.end();
    throw error;
  }
}

export function createIdentityRepository(loadStore: () => Promise<IdentityStore>): IdentityRepository {
  let storePromise: Promise<IdentityStore> | undefined;
  const getStore = () => storePromise ??= loadStore();
  return {
    async createSession(...args) { return (await getStore()).createSession(...args); },
    async findSession(...args) { return (await getStore()).findSession(...args); },
    async getUserWorkspaces(...args) { return (await getStore()).getUserWorkspaces(...args); },
    async removeSession(...args) { return (await getStore()).removeSession(...args); },
    async switchSessionWorkspace(...args) { return (await getStore()).switchSessionWorkspace(...args); },
    async getUserByEmail(...args) { return (await getStore()).getUserByEmail(...args); },
    async getWorkspaceForUser(...args) { return (await getStore()).getWorkspaceForUser(...args); },
    async createUser(...args) { return (await getStore()).createUser(...args); },
    async createEmailToken(...args) { return (await getStore()).createEmailToken(...args); },
    async consumeEmailToken(...args) { return (await getStore()).consumeEmailToken(...args); },
    async markTokenUsed(...args) { return (await getStore()).markTokenUsed(...args); },
    async markUserVerified(...args) { return (await getStore()).markUserVerified(...args); },
    async updatePassword(...args) { return (await getStore()).updatePassword(...args); },
    async updateUserName(...args) { return (await getStore()).updateUserName(...args); },
    async recordAuditEvent(...args) { return (await getStore()).recordAuditEvent(...args); },
    async listWorkspaceMembers(...args) { return (await getStore()).listWorkspaceMembers(...args); },
    async listAuditEvents(...args) { return (await getStore()).listAuditEvents(...args); },
    async addWorkspaceMember(...args) { return (await getStore()).addWorkspaceMember(...args); },
    async updateWorkspaceMemberRole(...args) { return (await getStore()).updateWorkspaceMemberRole(...args); },
    async removeWorkspaceMember(...args) { return (await getStore()).removeWorkspaceMember(...args); },
    async updateWorkspace(...args) { return (await getStore()).updateWorkspace(...args); },
    async createWorkspace(...args) { return (await getStore()).createWorkspace(...args); },
  };
}

export function createRuntimeIdentityRepository(
  databaseUrl = process.env.DATABASE_URL,
  loaders: {
    sqlite: () => Promise<IdentityStore>;
    postgres: (connectionString: string) => Promise<IdentityStore>;
  } = { sqlite: loadSqliteIdentityStore, postgres: loadPostgresIdentityStore },
  experimental = process.env.CHANGEGRAPH_POSTGRES_IDENTITY_EXPERIMENTAL,
): IdentityRepository {
  const connectionString = databaseUrl?.trim();
  // Domain data still uses SQLite. Only an explicit experimental opt-in plus
  // DATABASE_URL may switch identity storage; DATABASE_URL alone has no effect.
  return createIdentityRepository(() => experimental === "true" && connectionString
    ? loaders.postgres(connectionString)
    : loaders.sqlite());
}

export const identityRepository = createRuntimeIdentityRepository();

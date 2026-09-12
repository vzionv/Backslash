import { withSqliteTransaction } from "@/lib/db";

export class ProjectQuotaExceededError extends Error {
  constructor(readonly maxProjects: number) {
    super(`Project limit reached (max ${maxProjects})`);
    this.name = "ProjectQuotaExceededError";
  }
}

export interface RenameDatabaseUpdate {
  id: string;
  newPath: string;
}

function assertChanged(changes: number | bigint, operation: string): void {
  if (Number(changes) !== 1) {
    throw new Error(`${operation} affected ${changes.toString()} rows`);
  }
}

export function updateProjectFileAfterWrite(options: {
  projectId: string;
  fileId: string;
  sizeBytes: number;
  updatedAt: string;
}): void {
  withSqliteTransaction((database) => {
    const fileResult = database
      .prepare(
        "UPDATE project_files SET size_bytes = ?, updated_at = ? " +
          "WHERE id = ? AND project_id = ?"
      )
      .run(
        options.sizeBytes,
        options.updatedAt,
        options.fileId,
        options.projectId
      );
    assertChanged(fileResult.changes, "file metadata update");

    const projectResult = database
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(options.updatedAt, options.projectId);
    assertChanged(projectResult.changes, "project timestamp update");
  });
}

export function updateProjectFilesAfterBatchWrite(options: {
  projectId: string;
  files: Array<{ fileId: string; sizeBytes: number }>;
  updatedAt: string;
}): void {
  withSqliteTransaction((database) => {
    const statement = database.prepare(
      "UPDATE project_files SET size_bytes = ?, updated_at = ? " +
        "WHERE id = ? AND project_id = ? AND is_directory = 0"
    );
    for (const file of options.files) {
      const result = statement.run(
        file.sizeBytes,
        options.updatedAt,
        file.fileId,
        options.projectId
      );
      assertChanged(result.changes, `file metadata update ${file.fileId}`);
    }

    const projectResult = database
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(options.updatedAt, options.projectId);
    assertChanged(projectResult.changes, "project timestamp update");
  });
}

export function applyProjectFileRename(options: {
  projectId: string;
  updates: RenameDatabaseUpdate[];
  deleteIds?: string[];
  previousMainFile: string;
  nextMainFile: string;
  updatedAt: string;
}): void {
  withSqliteTransaction((database) => {
    if (options.deleteIds && options.deleteIds.length > 0) {
      const deleteStatement = database.prepare(
        "DELETE FROM project_files WHERE id = ? AND project_id = ?"
      );
      for (const fileId of options.deleteIds) {
        deleteStatement.run(fileId, options.projectId);
      }
    }

    const statement = database.prepare(
      "UPDATE project_files SET path = ?, updated_at = ? " +
        "WHERE id = ? AND project_id = ?"
    );
    for (const update of options.updates) {
      const result = statement.run(
        update.newPath,
        options.updatedAt,
        update.id,
        options.projectId
      );
      assertChanged(result.changes, `rename of file ${update.id}`);
    }

    if (options.nextMainFile !== options.previousMainFile) {
      const result = database
        .prepare(
          "UPDATE projects SET main_file = ?, updated_at = ? WHERE id = ?"
        )
        .run(options.nextMainFile, options.updatedAt, options.projectId);
      assertChanged(result.changes, "project main file update");
    } else {
      const result = database
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(options.updatedAt, options.projectId);
      assertChanged(result.changes, "project timestamp update");
    }
  });
}

export function deleteProjectFileRows(options: {
  projectId: string;
  fileIds: string[];
  previousMainFile: string;
  nextMainFile: string;
  updatedAt: string;
}): void {
  withSqliteTransaction((database) => {
    const statement = database.prepare(
      "DELETE FROM project_files WHERE id = ? AND project_id = ?"
    );
    for (const fileId of options.fileIds) {
      const result = statement.run(fileId, options.projectId);
      assertChanged(result.changes, `deletion of file ${fileId}`);
    }

    if (options.nextMainFile !== options.previousMainFile) {
      const result = database
        .prepare(
          "UPDATE projects SET main_file = ?, updated_at = ? WHERE id = ?"
        )
        .run(options.nextMainFile, options.updatedAt, options.projectId);
      assertChanged(result.changes, "project main file update");
    } else {
      const result = database
        .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
        .run(options.updatedAt, options.projectId);
      assertChanged(result.changes, "project timestamp update");
    }
  });
}

export function deleteProjectRecord(options: {
  projectId: string;
  ownerUserId: string;
}): void {
  withSqliteTransaction((database) => {
    const projectResult = database
      .prepare("DELETE FROM projects WHERE id = ? AND user_id = ?")
      .run(options.projectId, options.ownerUserId);
    assertChanged(projectResult.changes, "project deletion");

    database
      .prepare(
        "DELETE FROM labels WHERE user_id = ? " +
          "AND NOT EXISTS (" +
          "SELECT 1 FROM project_labels WHERE project_labels.label_id = labels.id" +
          ")"
      )
      .run(options.ownerUserId);
  });
}

export interface NewProjectFileRecord {
  id: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number;
  isDirectory: boolean;
}

export function createProjectWithFiles(options: {
  maxProjectsPerUser: number;
  project: {
    id: string;
    userId: string;
    name: string;
    description: string;
    engine: string;
    mainFile: string;
    createdAt: string;
    updatedAt: string;
  };
  files: NewProjectFileRecord[];
}): void {
  withSqliteTransaction((database) => {
    const countRow = database
      .prepare("SELECT COUNT(*) AS count FROM projects WHERE user_id = ?")
      .get(options.project.userId) as { count: number | bigint };
    if (Number(countRow.count) >= options.maxProjectsPerUser) {
      throw new ProjectQuotaExceededError(options.maxProjectsPerUser);
    }

    const projectResult = database
      .prepare(
        "INSERT INTO projects " +
          "(id, user_id, name, description, engine, main_file, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        options.project.id,
        options.project.userId,
        options.project.name,
        options.project.description,
        options.project.engine,
        options.project.mainFile,
        options.project.createdAt,
        options.project.updatedAt
      );
    assertChanged(projectResult.changes, "project creation");

    const insertFile = database.prepare(
      "INSERT INTO project_files " +
        "(id, project_id, path, mime_type, size_bytes, is_directory, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    );
    for (const file of options.files) {
      const result = insertFile.run(
        file.id,
        options.project.id,
        file.path,
        file.mimeType,
        file.sizeBytes,
        file.isDirectory ? 1 : 0,
        options.project.createdAt,
        options.project.updatedAt
      );
      assertChanged(result.changes, `project file creation ${file.path}`);
    }
  });
}

export function createProjectFileRecord(options: {
  id: string;
  projectId: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number;
  isDirectory: boolean;
  createdAt: string;
  updatedAt: string;
}): void {
  withSqliteTransaction((database) => {
    const fileResult = database
      .prepare(
        "INSERT INTO project_files " +
          "(id, project_id, path, mime_type, size_bytes, is_directory, created_at, updated_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
      )
      .run(
        options.id,
        options.projectId,
        options.path,
        options.mimeType,
        options.sizeBytes,
        options.isDirectory ? 1 : 0,
        options.createdAt,
        options.updatedAt
      );
    assertChanged(fileResult.changes, "project file creation");

    const projectResult = database
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(options.updatedAt, options.projectId);
    assertChanged(projectResult.changes, "project timestamp update");
  });
}

export interface ProjectUploadDirectoryRecord {
  id: string;
  path: string;
}

export interface ProjectUploadFileRecord {
  id: string;
  path: string;
  mimeType: string;
  sizeBytes: number;
  existing: boolean;
}

export function applyProjectUploadRecords(options: {
  projectId: string;
  directories: ProjectUploadDirectoryRecord[];
  files: ProjectUploadFileRecord[];
  updatedAt: string;
}): void {
  withSqliteTransaction((database) => {
    const insertDirectory = database.prepare(
      "INSERT INTO project_files " +
        "(id, project_id, path, mime_type, size_bytes, is_directory, created_at, updated_at) " +
        "VALUES (?, ?, ?, NULL, 0, 1, ?, ?)"
    );
    for (const directory of options.directories) {
      const result = insertDirectory.run(
        directory.id,
        options.projectId,
        directory.path,
        options.updatedAt,
        options.updatedAt
      );
      assertChanged(result.changes, `directory creation ${directory.path}`);
    }

    const insertFile = database.prepare(
      "INSERT INTO project_files " +
        "(id, project_id, path, mime_type, size_bytes, is_directory, created_at, updated_at) " +
        "VALUES (?, ?, ?, ?, ?, 0, ?, ?)"
    );
    const updateFile = database.prepare(
      "UPDATE project_files SET mime_type = ?, size_bytes = ?, updated_at = ? " +
        "WHERE id = ? AND project_id = ? AND is_directory = 0"
    );
    for (const file of options.files) {
      const result = file.existing
        ? updateFile.run(
            file.mimeType,
            file.sizeBytes,
            options.updatedAt,
            file.id,
            options.projectId
          )
        : insertFile.run(
            file.id,
            options.projectId,
            file.path,
            file.mimeType,
            file.sizeBytes,
            options.updatedAt,
            options.updatedAt
          );
      assertChanged(
        result.changes,
        `${file.existing ? "file update" : "file creation"} ${file.path}`
      );
    }

    const projectResult = database
      .prepare("UPDATE projects SET updated_at = ? WHERE id = ?")
      .run(options.updatedAt, options.projectId);
    assertChanged(projectResult.changes, "project timestamp update");
  });
}

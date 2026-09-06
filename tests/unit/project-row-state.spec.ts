import { expect, test } from "@playwright/test";

import { makeUnsavedSession } from "../../src/app/model/projectSession";
import type { ProjectSession } from "../../src/app/model/projectSession";
import type { ProjectLibraryRow } from "../../src/entities/project/model/types";
import {
  classifyFileError,
  getActivationPlan,
  getDeleteCapability,
  getDeleteConfirmText,
  getProjectRowLabel,
  getProjectRowStatus,
  isRowActivatable,
  isRowDeleteOnly,
  sortProjectRows
} from "../../src/features/project-library/model/projectRowState";
import type { ProjectRowProbe } from "../../src/features/project-library/model/projectRowState";
import type { FileHandleLike } from "../../src/shared/lib/fileSystemAccess";

function makeHandle(options: { removable?: boolean } = {}): FileHandleLike {
  const handle: FileHandleLike = {
    name: "project.mumbox",
    getFile: () => Promise.resolve(new File([], "project.mumbox"))
  };
  if (options.removable !== false) {
    handle.remove = () => Promise.resolve();
  }

  return handle;
}

function makeRow(patch: Partial<ProjectLibraryRow> = {}): ProjectLibraryRow {
  return {
    id: "project-1",
    fileName: "project.mumbox",
    projectName: "",
    description: "",
    sizeBytes: 1024,
    savedAt: "2024-01-05T09:07:00.000Z",
    lastOpenedAt: null,
    panelCount: 2,
    mediaCount: 5,
    handle: makeHandle(),
    ...patch
  };
}

const probe = (patch: Partial<ProjectRowProbe> = {}): ProjectRowProbe => ({
  permission: "granted",
  fileError: null,
  ...patch
});

test.describe("classifyFileError", () => {
  test("reads NotFoundError as a missing file", () => {
    expect(classifyFileError(new DOMException("gone", "NotFoundError"))).toBe("missing");
  });

  test("reads a permission failure as denied, never as missing", () => {
    expect(classifyFileError(new DOMException("no", "NotAllowedError"))).toBe("denied");
    expect(classifyFileError(new DOMException("no", "SecurityError"))).toBe("denied");
  });

  test("falls back to unknown for anything else", () => {
    expect(classifyFileError(new Error("boom"))).toBe("unknown");
    expect(classifyFileError("boom")).toBe("unknown");
  });
});

test.describe("getProjectRowStatus", () => {
  test("reports a reachable file as ready", () => {
    expect(getProjectRowStatus(makeRow(), probe())).toBe("ready");
  });

  test("reports a lapsed grant as needsPermission, and keeps the row usable", () => {
    const status = getProjectRowStatus(makeRow(), probe({ permission: "prompt" }));

    expect(status).toBe("needsPermission");
    expect(isRowActivatable(status)).toBe(true);
    expect(isRowDeleteOnly(status)).toBe(false);
  });

  test("reports a vanished file as missing and delete-only", () => {
    const status = getProjectRowStatus(makeRow(), probe({ fileError: "missing" }));

    expect(status).toBe("missing");
    expect(isRowActivatable(status)).toBe(false);
    expect(isRowDeleteOnly(status)).toBe(true);
  });

  test("a denied read is not a missing file", () => {
    expect(getProjectRowStatus(makeRow(), probe({ fileError: "denied" }))).toBe("needsPermission");
    expect(getProjectRowStatus(makeRow(), probe({ permission: "denied" }))).toBe("needsPermission");
  });

  test("a linked row that has not been probed yet reads as ready", () => {
    // The dialog paints before the probes resolve, so an unprobed row must not flash as broken.
    expect(getProjectRowStatus(makeRow(), undefined)).toBe("ready");
    expect(isRowDeleteOnly(getProjectRowStatus(makeRow(), undefined))).toBe(false);
  });

  test("a row without a handle is noHandle, never missing", () => {
    const status = getProjectRowStatus(makeRow({ handle: undefined }), undefined);

    expect(status).toBe("noHandle");
    expect(isRowDeleteOnly(status)).toBe(false);
    expect(isRowActivatable(status)).toBe(true);
  });
});

test.describe("getProjectRowLabel", () => {
  test("prefers the project name", () => {
    expect(getProjectRowLabel(makeRow({ projectName: "Выезд" }))).toBe("Выезд");
  });

  test("falls back to the file name for a blank project name", () => {
    expect(getProjectRowLabel(makeRow({ projectName: "   " }))).toBe("project.mumbox");
  });
});

test("sortProjectRows splits linked from unlinked and keeps their order", () => {
  const rows = [
    makeRow({ id: "a" }),
    makeRow({ id: "b", handle: undefined }),
    makeRow({ id: "c" }),
    makeRow({ id: "d", handle: undefined })
  ];
  const { linked, unlinked } = sortProjectRows(rows);

  expect(linked.map((row) => row.id)).toEqual(["a", "c"]);
  expect(unlinked.map((row) => row.id)).toEqual(["b", "d"]);
});

test.describe("getDeleteCapability", () => {
  test("reports diskAndList when every row can delete itself", () => {
    expect(getDeleteCapability([makeRow(), makeRow({ id: "b" })])).toBe("diskAndList");
  });

  test("reports listOnly when no row can", () => {
    expect(getDeleteCapability([makeRow({ handle: undefined })])).toBe("listOnly");
    expect(getDeleteCapability([makeRow({ handle: makeHandle({ removable: false }) })])).toBe(
      "listOnly"
    );
  });

  test("reports mixed for a mixed selection", () => {
    expect(getDeleteCapability([makeRow(), makeRow({ id: "b", handle: undefined })])).toBe("mixed");
  });
});

test.describe("getDeleteConfirmText", () => {
  const named = makeRow({ projectName: "Выезд" });

  test("promises a disk deletion only where one will happen", () => {
    expect(getDeleteConfirmText([named], "diskAndList")).toBe(
      'Удалить проект "Выезд"? Файл будет удалён с диска.'
    );
  });

  test("says plainly that the file survives when it will", () => {
    const text = getDeleteConfirmText([named], "listOnly");

    expect(text).toBe(
      'Удалить проект "Выезд" из списка? Файл на диске останется — этот браузер не умеет удалять файлы.'
    );
    // The guarantee this whole feature rests on: a dialog that lies is worse than no feature.
    expect(text).not.toMatch(/с диска будет удал/i);
    expect(text).not.toMatch(/будет удалён с диска/i);
  });

  test("counts several projects with correct Russian agreement", () => {
    const rows = [named, makeRow({ id: "b" })];

    expect(getDeleteConfirmText(rows, "diskAndList")).toBe(
      "Удалить 2 проекта? Файлы будут удалены с диска."
    );
    expect(getDeleteConfirmText(rows, "listOnly")).toBe(
      "Удалить 2 проекта из списка? Файлы на диске останутся."
    );
  });

  test("spells out what a mixed selection will actually do", () => {
    const rows = [named, makeRow({ id: "b", handle: undefined })];

    expect(getDeleteConfirmText(rows, "mixed")).toBe(
      "Удалить 2 проекта? С диска будет удалено: 1. Остальные исчезнут только из списка."
    );
  });

  test("says nothing with no rows", () => {
    expect(getDeleteConfirmText([], "listOnly")).toBe("");
  });
});

test.describe("getActivationPlan", () => {
  const saved: ProjectSession = {
    ...makeUnsavedSession(),
    projectId: "project-9",
    saved: true
  };

  test("offers three buttons when the current project was never saved", () => {
    const plan = getActivationPlan(makeUnsavedSession(), makeRow());

    expect(plan.kind).toBe("unsavedProject");
    expect(plan.kind === "unsavedProject" ? plan.buttons : []).toEqual([
      "Сохранить и открыть",
      "Без сохранения",
      "Отмена"
    ]);
  });

  test("offers three buttons when a saved project has unsaved edits", () => {
    const plan = getActivationPlan({ ...saved, dirty: true }, makeRow());

    expect(plan.kind).toBe("unsavedProject");
  });

  test("offers two buttons when the current project is saved and clean", () => {
    const plan = getActivationPlan(saved, makeRow());

    expect(plan.kind).toBe("savedProject");
    expect(plan.kind === "savedProject" ? plan.buttons : []).toEqual(["Открыть", "Отмена"]);
  });

  test("reports the row that is already open", () => {
    expect(getActivationPlan({ ...saved, projectId: "project-1" }, makeRow()).kind).toBe(
      "alreadyOpen"
    );
  });

  test("still asks when the open row has unsaved edits", () => {
    expect(
      getActivationPlan({ ...saved, projectId: "project-1", dirty: true }, makeRow()).kind
    ).toBe("unsavedProject");
  });
});

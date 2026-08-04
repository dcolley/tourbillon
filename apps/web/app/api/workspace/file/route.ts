import { NextRequest, NextResponse } from 'next/server';
import { getActiveCompany } from '@/lib/company';
import {
  readWorkspaceText,
  writeWorkspaceText,
  saveWorkspaceUpload,
  renameWorkspaceEntry,
  deleteWorkspaceEntry,
  resolveSafePath,
  WorkspacePathError,
  WorkspaceSizeError,
} from '@tourbillon/shared/company-workspace';
import { isTextEditablePath, isTextViewablePath } from '@tourbillon/shared/company-workspace-types';
import { stat } from 'fs/promises';

export async function GET(req: NextRequest) {
  const company = await getActiveCompany();
  const filePath = req.nextUrl.searchParams.get('path') ?? '';
  if (!filePath) {
    return NextResponse.json({ error: 'path is required.' }, { status: 400 });
  }

  try {
    if (isTextViewablePath(filePath)) {
      const file = await readWorkspaceText(company.id, filePath);
      return new NextResponse(file.content, {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Disposition': `inline; filename="${filePath.split('/').pop()}"`,
        },
      });
    }

    const absolute = await resolveSafePath(company.id, filePath);
    const fileStat = await stat(absolute);
    if (!fileStat.isFile()) {
      return NextResponse.json({ error: 'Not a file.' }, { status: 400 });
    }

    const { readFile } = await import('fs/promises');
    const data = await readFile(absolute);
    const name = filePath.split('/').pop() ?? 'download';
    return new NextResponse(data, {
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    throw err;
  }
}

export async function POST(req: NextRequest) {
  const company = await getActiveCompany();
  const formData = await req.formData();
  const file = formData.get('file');
  const targetDir = (formData.get('targetDir') as string | null)?.trim() ?? '';

  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: 'file is required.' }, { status: 400 });
  }

  const baseName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const relativePath = targetDir ? `${targetDir}/${baseName}` : baseName;

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await saveWorkspaceUpload(company.id, relativePath, buffer);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError || err instanceof WorkspaceSizeError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function PUT(req: NextRequest) {
  const company = await getActiveCompany();
  const body = (await req.json()) as { path?: string; content?: string };

  if (!body.path || typeof body.content !== 'string') {
    return NextResponse.json({ error: 'path and content are required.' }, { status: 400 });
  }

  if (!isTextEditablePath(body.path)) {
    return NextResponse.json({ error: 'File type is not editable.' }, { status: 400 });
  }

  try {
    const result = await writeWorkspaceText(company.id, body.path, body.content);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof WorkspaceSizeError) {
      return NextResponse.json({ error: err.message }, { status: 413 });
    }
    throw err;
  }
}

export async function PATCH(req: NextRequest) {
  const company = await getActiveCompany();
  const body = (await req.json()) as {
    from?: string;
    to?: string;
    /** When true, destination must remain a text-editable file path. */
    requireEditable?: boolean;
  };

  if (!body.from?.trim() || !body.to?.trim()) {
    return NextResponse.json({ error: 'from and to are required.' }, { status: 400 });
  }

  if (body.requireEditable && !isTextEditablePath(body.to)) {
    return NextResponse.json(
      { error: 'New path must use an editable extension (.md, .txt, .json, .jsonl, .yaml, .yml, .csv).' },
      { status: 400 }
    );
  }

  try {
    const result = await renameWorkspaceEntry(company.id, body.from, body.to);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }
}

export async function DELETE(req: NextRequest) {
  const company = await getActiveCompany();
  const filePath = req.nextUrl.searchParams.get('path') ?? '';
  if (!filePath) {
    return NextResponse.json({ error: 'path is required.' }, { status: 400 });
  }

  try {
    const result = await deleteWorkspaceEntry(company.id, filePath);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WorkspacePathError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return NextResponse.json({ error: 'Not found.' }, { status: 404 });
    }
    throw err;
  }
}

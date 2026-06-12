import { NextRequest, NextResponse } from 'next/server';
import { getOrCreateDefaultCompany } from '@/lib/company';
import {
  readWorkspaceText,
  saveWorkspaceUpload,
  resolveSafePath,
  WorkspacePathError,
  WorkspaceSizeError,
} from '@tourbillon/shared/company-workspace';
import { isTextEditablePath } from '@tourbillon/shared/company-workspace-types';
import { stat } from 'fs/promises';

export async function GET(req: NextRequest) {
  const company = await getOrCreateDefaultCompany();
  const filePath = req.nextUrl.searchParams.get('path') ?? '';
  if (!filePath) {
    return NextResponse.json({ error: 'path is required.' }, { status: 400 });
  }

  try {
    if (isTextEditablePath(filePath)) {
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
  const company = await getOrCreateDefaultCompany();
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

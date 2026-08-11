import { NextRequest, NextResponse } from 'next/server';

export function middleware(request: NextRequest) {
  const desktopOnly = process.env.DUBFLOW_DESKTOP_ONLY === 'true';
  const expectedToken = process.env.DUBFLOW_DESKTOP_TOKEN || '';

  if (!desktopOnly || !expectedToken) {
    return NextResponse.next();
  }

  const receivedToken = request.headers.get('x-dubflow-desktop-token') || '';
  if (receivedToken === expectedToken) {
    return NextResponse.next();
  }

  return new NextResponse('DubFlow desktop app only.', {
    status: 403,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'x-dubflow-desktop-only': 'true',
    },
  });
}

export const config = {
  matcher: '/:path*',
};

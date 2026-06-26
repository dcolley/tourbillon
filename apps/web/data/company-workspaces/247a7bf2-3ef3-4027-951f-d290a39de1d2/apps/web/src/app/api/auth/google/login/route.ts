import { NextRequest, NextResponse } from 'next/server';

export async function GET(request: NextRequest) {
  try {
    const googleClientId = process.env.GOOGLE_CLIENT_ID;
    
    if (!googleClientId) {
      return NextResponse.json(
        { error: 'Google client ID not configured. Set GOOGLE_CLIENT_ID in environment variables.' },
        { status: 500 }
      );
    }

    const redirectUri = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/api/auth/google/callback`;

    // Generate CSRF state parameter with timestamp and nonce for security
    const secret = process.env.SESSION_SECRET || 'dev-session-secret-change-in-production';
    const crypto = require('crypto');
    const hmac = crypto.createHmac('sha256', secret);
    const timestamp = Date.now();
    hmac.update(timestamp.toString());
    const nonce = hmac.digest('hex').slice(0, 8);
    
    // Encode state as base64 JSON containing timestamp and nonce
    const statePayload = JSON.stringify({ timestamp, nonce });
    const state = Buffer.from(statePayload).toString('base64');

    // Build proper OAuth URL without newlines or spaces
    const params = new URLSearchParams({
      client_id: googleClientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      access_type: 'offline',
      prompt: 'consent',
      state,
    });

    const redirectUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

    return NextResponse.redirect(redirectUrl);
  } catch (error) {
    console.error('Google login error:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}

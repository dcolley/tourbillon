import { NextRequest, NextResponse } from 'next/server';

/**
 * Auth0 Logout Route - Signs out user and clears session
 * 
 * Clears the local session cookie and redirects to Auth0 logout page.
 */

export async function GET(request: NextRequest) {
  try {
    const auth0Domain = process.env.AUTH0_DOMAIN;
    const clientId = process.env.AUTH0_CLIENT_ID;
    
    if (!auth0Domain || !clientId) {
      console.error('Auth0 configuration missing');
      return NextResponse.redirect(
        `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/auth/login?error=logout_failed`
      );
    }

    const cookieStore = cookies();
    
    // Clear the session cookie
    cookieStore.delete('session');

    // Build Auth0 logout URL
    const callbackUrl = `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/auth/login`;
    
    const logoutParams = new URLSearchParams({
      client_id: clientId,
      returnTo: callbackUrl,
    });

    const logoutUrl = `https://${auth0Domain}/v2/logout?${logoutParams.toString()}`;

    return NextResponse.redirect(logoutUrl);
  } catch (error) {
    console.error('Auth0 logout error:', error);
    
    // Fallback: clear cookie and redirect to login even if Auth0 fails
    const cookieStore = cookies();
    cookieStore.delete('session');
    
    return NextResponse.redirect(
      `${process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000'}/auth/login?error=logout_failed`
    );
  }
}

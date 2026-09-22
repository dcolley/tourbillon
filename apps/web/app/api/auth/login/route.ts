/**
 * POST /api/auth/login
 * User login endpoint with email/password authentication
 * 
 * Request: { email: string, password: string }
 * Success: { success: true, sessionId: string, userId: string }
 * Error: { success: false, error: string }
 * Status codes: 200 (success), 401 (bad credentials), 400 (malformed request)
 */

import { NextRequest, NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import { z } from 'zod';

const loginSchema = z.object({
  email: z.string().email('Invalid email format'),
  password: z.string().min(1, 'Password is required'),
});

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    
    // Validate request body
    const validation = loginSchema.safeParse(body);
    if (!validation.success) {
      return NextResponse.json(
        { 
          success: false, 
          error: validation.error.issues[0]?.message || 'Invalid request format' 
        },
        { status: 400 }
      );
    }

    const { email, password } = validation.data;

    // Create a Request object for better-auth
    const authRequest = new Request(`${process.env.BETTER_AUTH_URL}/api/auth/sign-in/email`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password }),
    });

    // Attempt to sign in with better-auth
    const authResponse = await auth.handler(authRequest);

    // Parse the response
    const result = await authResponse.json();

    // Check if authentication succeeded (HTTP 200 + user object)
    if (authResponse.status === 200 && result.user) {
      // Create response with session cookie
      const response = NextResponse.json(
        {
          success: true,
          sessionId: result.session?.id || result.token,
          userId: result.user.id,
        },
        { status: 200 }
      );

      // Forward all auth cookies from the upstream response
      const setCookieHeaders = authResponse.headers.getSetCookie?.() || [];
      if (setCookieHeaders.length > 0) {
        setCookieHeaders.forEach(cookie => {
          response.headers.append('set-cookie', cookie);
        });
      } else {
        // Fallback for environments without getSetCookie
        const cookies = authResponse.headers.get('set-cookie');
        if (cookies) {
          response.headers.set('set-cookie', cookies);
        }
      }

      return response;
    }

    // Authentication failed
    return NextResponse.json(
      { 
        success: false, 
        error: result.error?.message || 'Invalid email or password' 
      },
      { status: 401 }
    );

  } catch (error) {
    console.error('Login error:', error);
    return NextResponse.json(
      { 
        success: false, 
        error: 'Internal server error' 
      },
      { status: 500 }
    );
  }
}

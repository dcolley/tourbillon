import { NextResponse } from 'next/server'
import { z } from 'zod'

// Validation schema for demo requests
const demoRequestSchema = z.object({
  name: z.string().min(1, 'Name is required').max(100),
  email: z.string().email('Invalid email address'),
  company: z.string().min(1, 'Company name is required').max(200),
  size: z.enum(['1-10', '11-50', '51-200', '201-500', '500+']),
  message: z.string().max(1000, 'Message too long').optional(),
})

// Mock email sending function (in production, use SMTP or email service)
async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  // In production, replace with actual email integration (e.g., SendGrid, AWS SES, Nodemailer)
  console.log(`📧 Email sent to ${to}`)
  console.log(`Subject: ${subject}`)
  console.log(`Body:\n${body}`)
  
  // Log to file for audit trail in development
  const timestamp = new Date().toISOString()
  console.log(`[${timestamp}] EMAIL_LOG: ${JSON.stringify({ to, subject, body })}`)
}

// Store demo requests (in production, replace with database)
const demoRequests: Array<z.infer<typeof demoRequestSchema> & { id: string; createdAt: Date }> = []

export async function POST(request: Request) {
  try {
    const body = await request.json()
    
    // Validate input
    const validationResult = demoRequestSchema.safeParse(body)
    
    if (!validationResult.success) {
      return NextResponse.json(
        { 
          error: 'Validation failed',
          details: validationResult.error.errors.map(e => ({
            field: e.path.join('.'),
            message: e.message,
          }))
        },
        { status: 400 }
      )
    }
    
    const data = validationResult.data
    
    // Generate unique ID for this demo request
    const id = `demo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`
    const createdAt = new Date()
    
    // Store the demo request (in production, save to database)
    demoRequests.push({ ...data, id, createdAt })
    
    // Send notification email to sales/ops team
    await sendEmail(
      'sales@tourbillon.com',
      `New Demo Request from ${data.name}`,
      `You have a new demo request:\n\nName: ${data.name}\nEmail: ${data.email}\nCompany: ${data.company}\nSize: ${data.size} employees\nMessage: ${data.message || 'No message provided'}\n\nPlease follow up with the prospect.`
    )
    
    // Send confirmation email to user
    await sendEmail(
      data.email,
      'Thank you for requesting a Tourbillon demo!',
      `Hi ${data.name},\n\nThank you for your interest in Tourbillon! We've received your demo request and will be in touch shortly.\n\nHere's what to expect:\n1. Our team will review your requirements\n2. We'll schedule a personalized demo at your convenience\n3. You'll receive access to our platform during the demo\n\nIn the meantime, feel free to explore our documentation at docs.tourbillon.com\n\nBest regards,\nThe Tourbillon Team`
    )
    
    return NextResponse.json(
      { 
        success: true,
        id,
        message: 'Demo request submitted successfully',
        confirmationSent: true,
        notificationSent: true
      },
      { status: 201 }
    )
  } catch (error) {
    console.error('Error processing demo request:', error)
    
    return NextResponse.json(
      { 
        error: 'Internal server error',
        message: 'An unexpected error occurred. Please try again later.'
      },
      { status: 500 }
    )
  }
}

// GET endpoint to retrieve demo requests (for admin purposes)
export async function GET() {
  // In production, add authentication/authorization check
  
  return NextResponse.json({
    count: demoRequests.length,
    requests: demoRequests.slice(-10).map(({ id, name, email, company, createdAt }) => ({
      id,
      name,
      email,
      company,
      createdAt: createdAt.toISOString(),
    })),
  })
}

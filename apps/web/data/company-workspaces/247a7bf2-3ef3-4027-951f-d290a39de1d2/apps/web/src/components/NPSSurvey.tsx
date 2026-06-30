'use client';

import { useState } from 'react';

interface NPSSurveyProps {
  userId?: string;
  email?: string;
  onDismiss: () => void;
}

export default function NPSSurvey({ userId, email, onDismiss }: NPSSurveyProps) {
  const [score, setScore] = useState<number | null>(null);
  const [comment, setComment] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // NPS scoring: Detractors (0-6), Passives (7-8), Promoters (9-10)
  const getNPSRating = (s: number): string => {
    if (s <= 6) return 'Detractor';
    if (s <= 8) return 'Passive';
    return 'Promoter';
  };

  const getEmoji = (s: number): string => {
    if (s <= 6) return '😞';
    if (s <= 8) return '😊';
    return '🤩';
  };

  const handleSubmit = async () => {
    if (score === null) {
      setError('Please select a score before submitting.');
      return;
    }

    try {
      const response = await fetch('/api/nps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          email,
          score,
          comment: comment || null,
        }),
      });

      if (!response.ok) {
        const data = await response.json();
        throw new Error(data.error || 'Failed to submit NPS response');
      }

      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong.');
    }
  };

  if (submitted) {
    return (
      <div className="nps-survey nps-success">
        <h3>Thank You!</h3>
        <p>Your feedback has been recorded. We appreciate your input.</p>
        <button onClick={onDismiss}>Close</button>
      </div>
    );
  }

  return (
    <div className="nps-survey">
      <h3>How likely are you to recommend Tourbillon?</h3>
      
      {error && <p className="nps-error">{error}</p>}

      <div className="nps-rating">
        {[0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((num) => (
          <button
            key={num}
            onClick={() => setScore(num)}
            className={`nps-btn ${score === num ? 'selected' : ''}`}
            aria-label={`Rate ${num}`}
          >
            {getEmoji(num)} {num}
          </button>
        ))}
      </div>

      <p className="nps-scale">
        0 = Not at all likely | 10 = Extremely likely
      </p>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Anything else you'd like to share? (optional)"
        maxLength={500}
      />

      <button onClick={handleSubmit} className="nps-submit">Submit Feedback</button>
      
      <button onClick={onDismiss} className="nps-dismiss">Not now</button>
    </div>
  );
}

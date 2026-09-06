import { describe, expect, it } from 'vitest'
import { configProblem, DEFAULT_WHATSAPP_CONFIG } from './whatsapp-config'

// Whether a saved WhatsApp setup will actually work. Pure, and tested, because
// the route and the screen have to reach the same answer: a switch that says On
// over a number nothing can be sent from is the sort of thing somebody only
// finds out about when a customer says they never got the reply.

describe('configProblem', () => {
  it('has nothing to say about a setup that is switched off', () => {
    expect(configProblem({ ...DEFAULT_WHATSAPP_CONFIG, enabled: false, sender: '' })).toBeNull()
  })

  it('refuses On with no sender', () => {
    const problem = configProblem({ ...DEFAULT_WHATSAPP_CONFIG, enabled: true, sender: '' })
    expect(problem).toContain('Choose the number')
  })

  it('refuses a number that is not in international format', () => {
    const problem = configProblem({ ...DEFAULT_WHATSAPP_CONFIG, enabled: true, sender: '07700900123' })
    expect(problem).toContain('international format')
  })

  it('accepts a real one', () => {
    expect(
      configProblem({ enabled: true, sender: '+447700900123', region: 'ie1' }),
    ).toBeNull()
  })

  // Twilio's shared sandbox sender is a United States number and is what every
  // account starts on, so it has to pass the same check as a number of the
  // site's own.
  it('accepts the Twilio sandbox sender', () => {
    expect(configProblem({ enabled: true, sender: '+14155238886', region: 'us1' })).toBeNull()
  })
})

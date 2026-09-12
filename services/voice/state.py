"""Voice service state machine (ADR-0001 Phase 3 skeleton).

Pure stdlib. No fastapi / numpy / provider imports here so this module is
trivially unit-testable in isolation.
"""

from enum import Enum


class VoiceState(str, Enum):
    IDLE = "IDLE"
    WAKE = "WAKE"
    LISTENING = "LISTENING"
    TRANSCRIBING = "TRANSCRIBING"
    ROUTING = "ROUTING"
    EXECUTING = "EXECUTING"
    RESPONDING = "RESPONDING"
    SPEAKING = "SPEAKING"
    INTERRUPTED = "INTERRUPTED"


# Normal flow:
#   IDLE -> (wake enabled ? WAKE : LISTENING) -> TRANSCRIBING -> ROUTING
#        -> EXECUTING -> RESPONDING -> SPEAKING -> IDLE
# Barge-in:
#   SPEAKING / RESPONDING / EXECUTING -> INTERRUPTED -> LISTENING
# Every state can return to IDLE (via reset() or a direct transition).
ALLOWED = {
    VoiceState.IDLE: frozenset({VoiceState.WAKE, VoiceState.LISTENING}),
    VoiceState.WAKE: frozenset({VoiceState.LISTENING, VoiceState.IDLE}),
    VoiceState.LISTENING: frozenset({VoiceState.TRANSCRIBING, VoiceState.IDLE}),
    VoiceState.TRANSCRIBING: frozenset(
        {VoiceState.ROUTING, VoiceState.LISTENING, VoiceState.IDLE}
    ),
    VoiceState.ROUTING: frozenset({VoiceState.EXECUTING, VoiceState.IDLE}),
    VoiceState.EXECUTING: frozenset(
        {VoiceState.RESPONDING, VoiceState.INTERRUPTED, VoiceState.IDLE}
    ),
    VoiceState.RESPONDING: frozenset(
        {VoiceState.SPEAKING, VoiceState.INTERRUPTED, VoiceState.IDLE}
    ),
    VoiceState.SPEAKING: frozenset({VoiceState.INTERRUPTED, VoiceState.IDLE}),
    VoiceState.INTERRUPTED: frozenset({VoiceState.LISTENING, VoiceState.IDLE}),
}


class InvalidTransition(ValueError):
    """Raised when a state transition violates ALLOWED edges."""


class StateMachine:
    """Minimal validated state holder with transition hooks."""

    def __init__(self, initial: VoiceState = VoiceState.IDLE):
        self._state = initial
        # Callback hook list: fn(from_state, to_state) -> None (sync).
        self.on_transition: list = []

    @property
    def state(self) -> VoiceState:
        return self._state

    def _fire(self, old: VoiceState, new: VoiceState) -> None:
        for cb in list(self.on_transition):
            cb(old, new)

    def transition(self, to: VoiceState) -> VoiceState:
        """Move to ``to`` if the edge is allowed, else raise InvalidTransition.

        Transitioning to the current state is a no-op (no hooks fired).
        """
        to = VoiceState(to)
        if to == self._state:
            return self._state
        if to not in ALLOWED[self._state]:
            raise InvalidTransition(f"{self._state.value} -> {to.value} not allowed")
        old = self._state
        self._state = to
        self._fire(old, to)
        return self._state

    def reset(self) -> VoiceState:
        """Force return to IDLE from any state (no-op if already IDLE)."""
        if self._state == VoiceState.IDLE:
            return self._state
        old = self._state
        self._state = VoiceState.IDLE
        self._fire(old, VoiceState.IDLE)
        return self._state

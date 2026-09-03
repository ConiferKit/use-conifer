"""Receipts for the client you already use. The OpenAI Python SDK takes an ``http_client`` and httpx exposes response hooks; this one reads the ``x-conifer-*`` headers on the way past and never touches the body."""

from __future__ import annotations

import threading
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, List, Mapping, Optional, Sequence

from .receipt import Receipt, nano_usd_to_usd_string, read_receipt


@dataclass
class ObservedReceipt:
    """One turn's receipt, plus where and when it came from."""

    receipt: Receipt
    #: The URL that was called.
    url: str
    #: When the response arrived.
    at: datetime

    @property
    def cost_nano_usd(self) -> Optional[int]:
        return self.receipt.cost_nano_usd

    @property
    def effective_model(self) -> Optional[str]:
        return self.receipt.effective_model


@dataclass
class ReceiptTotal:
    """A running total across every observed turn."""

    #: Number of turns that disclosed a receipt.
    turns: int
    #: Summed settled cost, in integer nanodollars.
    cost_nano_usd: int
    #: The same number as an exact decimal USD string.
    cost_usd: str
    #: Summed counterfactual over the turns that disclosed one; a subset, not a savings figure.
    counterfactual_nano_usd: int
    counterfactual_turns: int


class ReceiptCollector:
    """Collects the receipt from every response that carries one. Thread-safe."""

    def __init__(
        self,
        on_receipt: Optional[Callable[[ObservedReceipt], None]] = None,
        retain: int = 1000,
    ) -> None:
        #: Called as each receipt arrives.
        self._on_receipt = on_receipt
        #: How many receipts to keep in ``all``. 0 keeps none. The total is exact regardless.
        self._retain = retain
        self._observed: List[ObservedReceipt] = []
        self._lock = threading.Lock()
        self._seen = 0
        self._summed = 0
        self._summed_counterfactual = 0
        self._counterfactual_turns = 0

    # ------------------------------------------------------------ collection

    def observe(self, headers: Mapping[str, str], url: str = "") -> Optional[ObservedReceipt]:
        """Read a receipt off one response's headers. The generic entry point."""
        receipt = read_receipt(headers)
        if receipt.cost_nano_usd is None and receipt.effective_model is None:
            return None
        observed = ObservedReceipt(receipt=receipt, url=url, at=datetime.now(timezone.utc))
        self._record(observed)
        return observed

    def httpx_hook(self, response: Any) -> None:
        """An httpx ``response`` event hook."""
        self.observe(response.headers, str(getattr(response, "url", "")))

    def _record(self, observed: ObservedReceipt) -> None:
        with self._lock:
            self._seen += 1
            if observed.receipt.cost_nano_usd is not None:
                self._summed += observed.receipt.cost_nano_usd
            if observed.receipt.counterfactual_nano_usd is not None:
                self._summed_counterfactual += observed.receipt.counterfactual_nano_usd
                self._counterfactual_turns += 1
            if self._retain > 0:
                self._observed.append(observed)
                if len(self._observed) > self._retain:
                    self._observed.pop(0)
        # Outside the lock: a throwing callback must not fail a turn the caller already paid for.
        if self._on_receipt is not None:
            try:
                self._on_receipt(observed)
            except Exception:  # noqa: BLE001 - the callback's problem, not the request's
                pass

    # --------------------------------------------------------------- reading

    @property
    def all(self) -> Sequence[ObservedReceipt]:
        """The retained receipts, oldest first. A bounded tail; see ``retain``."""
        with self._lock:
            return list(self._observed)

    @property
    def last(self) -> Optional[ObservedReceipt]:
        """The most recent receipt, which is what a one-shot script wants."""
        with self._lock:
            return self._observed[-1] if self._observed else None

    @property
    def total(self) -> ReceiptTotal:
        """The running total over every turn seen, including any dropped from ``all``."""
        with self._lock:
            return ReceiptTotal(
                turns=self._seen,
                cost_nano_usd=self._summed,
                cost_usd=nano_usd_to_usd_string(self._summed),
                counterfactual_nano_usd=self._summed_counterfactual,
                counterfactual_turns=self._counterfactual_turns,
            )

    def reset(self) -> None:
        """Forget the retained receipts AND reset the total."""
        with self._lock:
            self._observed.clear()
            self._seen = 0
            self._summed = 0
            self._summed_counterfactual = 0
            self._counterfactual_turns = 0


class SpendBudget:
    """A hard spend ceiling across MANY turns, enforced client-side."""

    def __init__(self, budget_nano_usd: int) -> None:
        if not isinstance(budget_nano_usd, int) or isinstance(budget_nano_usd, bool):
            raise ValueError(
                "a spend budget is an INTEGER nanodollar amount ($1 = 1e9). Rounding a "
                "spend limit is the wrong direction half the time."
            )
        if budget_nano_usd < 0:
            raise ValueError("a spend budget cannot be negative")
        self.budget_nano_usd = budget_nano_usd
        self.collector = ReceiptCollector(retain=0)

    @property
    def spent_nano_usd(self) -> int:
        """Nanodollars spent so far, as observed on real receipts."""
        return self.collector.total.cost_nano_usd

    @property
    def remaining_nano_usd(self) -> int:
        """Nanodollars left. Never negative."""
        return max(0, self.budget_nano_usd - self.spent_nano_usd)

    @property
    def exhausted(self) -> bool:
        return self.spent_nano_usd >= self.budget_nano_usd

    def check(self) -> None:
        """Raise if the budget is gone. Call BEFORE issuing a request."""
        if self.exhausted:
            raise SpendBudgetExceeded(
                f"spend budget exhausted: {nano_usd_to_usd_string(self.spent_nano_usd)} USD "
                f"spent against a {nano_usd_to_usd_string(self.budget_nano_usd)} USD budget. "
                "This refusal is CLIENT-SIDE; the gateway was not called."
            )

    def httpx_hook(self, response: Any) -> None:
        """Observe a response's receipt against the budget."""
        self.collector.httpx_hook(response)


class SpendBudgetExceeded(RuntimeError):
    """The client-side multi-turn budget is spent. No request was made."""

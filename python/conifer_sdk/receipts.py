"""Receipts for the client you ALREADY use.

THE PROBLEM THIS SOLVES. The exact per-turn cost is the one thing Conifer has
that other gateways do not, and it arrives on the RESPONSE HEADERS. Every
mainstream client — ``openai``, ``anthropic``, LangChain, LiteLLM — parses the
JSON body and throws the headers away. So the moment someone points their
existing client at Conifer (which is the whole point of being
OpenAI-compatible), the differentiator becomes invisible.

The old answer was "rewrite against conifer_sdk". That is a bad trade to ask for
on day one, and it is not even necessary: the OpenAI Python SDK takes an
``http_client``, and httpx exposes response event hooks. So this module hands
them a hook that reads the receipt on the way past.

    import httpx
    from openai import OpenAI
    from conifer_sdk.receipts import ReceiptCollector

    receipts = ReceiptCollector()
    openai = OpenAI(
        base_url="https://api.conifer.build/v1",
        api_key=os.environ["CONIFER_API_KEY"],
        http_client=httpx.Client(event_hooks={"response": [receipts.httpx_hook]}),
    )
    openai.chat.completions.create(...)
    receipts.total.cost_nano_usd      # exact, integer, itemized

WHY THIS IS SAFE TO WRAP AROUND SOMEONE ELSE'S CLIENT. The hook never reads or
consumes the response BODY. On a streaming response the body has not even
arrived when the hook runs, and touching it would raise or break the stream.
Headers are available immediately, so reading them costs nothing and changes
nothing.

``httpx`` is NOT imported here and is NOT a dependency: the hook takes anything
with a ``.headers`` mapping, which is what makes this work with httpx,
requests, urllib3 or a test double alike.
"""

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
    #: The URL that was called, so a mixed workload stays attributable.
    url: str
    #: When the response arrived, for correlating with your own logs.
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
    #: Summed counterfactual over ONLY the turns that disclosed one. The gateway
    #: omits that header unless the routed predicate holds, so this is a sum
    #: over a SUBSET and is not comparable to ``cost_nano_usd`` as a savings
    #: figure — ``counterfactual_turns`` is published beside it so the
    #: difference is visible rather than implied.
    counterfactual_nano_usd: int
    counterfactual_turns: int


class ReceiptCollector:
    """Collects the receipt from every response that carries one.

    Thread-safe: an ``openai`` client is routinely shared across threads, and a
    spend total that silently loses increments under concurrency would be worse
    than no total at all.
    """

    def __init__(
        self,
        on_receipt: Optional[Callable[[ObservedReceipt], None]] = None,
        retain: int = 1000,
    ) -> None:
        #: Called as each receipt arrives. For metrics, logs, a budget guard.
        self._on_receipt = on_receipt
        #: How many receipts to RETAIN. A long-lived process makes an unbounded
        #: list a slow leak, and the running total is the part that matters, so
        #: the total is exact forever while the list is a bounded tail. Set 0 to
        #: retain none and rely on ``on_receipt`` plus ``total``.
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
        """An httpx ``response`` event hook.

        Duck-typed on purpose: anything with ``.headers`` and ``.url`` works,
        so httpx is neither imported nor required.

        Reads HEADERS ONLY. On a streaming response the body has not arrived
        when this runs, and touching it would raise or break the stream.
        """
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
        # Outside the lock, and isolated: a throwing callback is the CALLER's
        # bug. It must not corrupt the total, deadlock the next call, or — far
        # worse — fail their inference request. They already paid for that turn.
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
        """The running total.

        EXACT over every turn ever seen, including any the retention cap
        dropped from ``all``: a spend figure that quietly stopped counting
        would be worse than no figure at all.
        """
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
    """A hard spend ceiling across MANY turns, enforced client-side.

    ``max_cost_nano_usd`` is a per-request ceiling the gateway enforces. This is
    the other question — "this whole job must not cost more than $5" — which no
    single request can answer.

    Be precise about what this can and cannot do. It refuses the NEXT request
    once the budget is spent; it cannot refund the one that crossed the line,
    because the cost is only known after the turn settles. So the true worst
    case is ``budget + one turn``. Combine it with a per-request
    ``max_cost_nano_usd`` and that overshoot is bounded rather than open-ended.
    """

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

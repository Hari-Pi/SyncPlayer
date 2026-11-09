import { Check, UserPlus, X } from "lucide-react";
import type { PendingJoinRequest } from "@/features/room/usePeerRoom";
import { cx } from "@/lib/ui/cx";

export function PendingJoinRequests({
  requests,
  onAccept,
  onDecline,
  className
}: {
  requests: PendingJoinRequest[];
  onAccept: (request: PendingJoinRequest) => void;
  onDecline: (request: PendingJoinRequest) => void;
  className?: string;
}) {
  if (requests.length === 0) {
    return null;
  }

  return (
    <div className={cx("pending-requests", className)}>
      <span className="section-title">
        <UserPlus size={11} />
        Join Requests ({requests.length})
      </span>
      <ul className="pending-request-list">
        {requests.map((request) => (
          <li key={request.peerId} className="pending-request-item">
            <span className="pending-request-item__label">{request.label}</span>
            <div className="pending-request-item__actions">
              <button
                type="button"
                className="pending-request-item__accept"
                onClick={() => onAccept(request)}
              >
                <Check size={13} />
                Accept
              </button>
              <button
                type="button"
                className="pending-request-item__decline"
                onClick={() => onDecline(request)}
              >
                <X size={13} />
                Decline
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

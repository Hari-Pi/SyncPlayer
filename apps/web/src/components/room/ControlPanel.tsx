import { Link2, LogIn, Radar, Send, RadioTower } from "lucide-react";
import type { usePeerRoom } from "@/features/room/usePeerRoom";

export function ControlPanel({
  role,
  status,
  room,
  inviteLink,
  onHost,
  onJoin,
  onLeave,
  joinCode,
  setJoinCode,
  responseInput,
  setResponseInput
}: {
  role: "solo" | "host" | "guest";
  status: string;
  room: ReturnType<typeof usePeerRoom>;
  inviteLink: string;
  onHost: () => void;
  onJoin: () => void;
  onLeave: () => void;
  joinCode: string;
  setJoinCode: (v: string) => void;
  responseInput: string;
  setResponseInput: (v: string) => void;
}) {
  return (
    <section className="panel">
      <div className="panel__header">
        <span className="panel__title">
          <Radar size={15} />
          Network
        </span>
        <span className="panel__rail" />
      </div>

      <div className="form-layout">
        {role === "solo" && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" }}>
            <button className="primary-action" onClick={onHost}>
              <RadioTower size={18} />
              Host Room
            </button>
            <div className="guest-join">
              <input
                className="input-text"
                placeholder="4-digit PIN"
                maxLength={4}
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && joinCode.length === 4) onJoin();
                }}
              />
              <button
                className="primary-action"
                disabled={joinCode.length !== 4 || status === "pairing"}
                onClick={onJoin}
              >
                <LogIn size={18} />
                Join
              </button>
            </div>
          </div>
        )}

        {role === "host" && (
          <div className="host-controls">
            <div className="host-status">
              <div className="pulse-dot" />
              Hosting Room {room.roomCode}
            </div>
            {inviteLink && (
              <div className="share-link">
                <input readOnly value={inviteLink} className="input-text" onClick={(e) => e.currentTarget.select()} />
                <button className="secondary-action" onClick={() => navigator.clipboard.writeText(inviteLink)}>
                  <Link2 size={15} />
                  Copy Invite Link
                </button>
              </div>
            )}
            <button className="danger-action" onClick={onLeave}>
              Close Room
            </button>
          </div>
        )}

        {role === "guest" && (
          <div className="guest-controls">
            {status === "pairing" && (
              <>
                <p>Enter the response block provided by the host:</p>
                <textarea
                  className="input-text"
                  rows={3}
                  value={responseInput}
                  onChange={(e) => setResponseInput(e.target.value)}
                  placeholder="Paste #sync=... here"
                />
                <button
                  className="primary-action"
                  disabled={!responseInput}
                  onClick={() => {
                    if (responseInput.includes("#sync=")) {
                      try {
                        const hash = responseInput.split("#sync=")[1];
                        const payload = JSON.parse(atob(hash.replaceAll("-", "+").replaceAll("_", "/").padEnd(hash.length + (4 - (hash.length % 4)) % 4, "=")));
                        if (payload.type === "response") {
                          room.acceptGuestAnswer(payload.answer);
                        }
                      } catch (e) {
                        console.error(e);
                      }
                    } else {
                      room.acceptGuestAnswer(responseInput);
                    }
                  }}
                >
                  <Send size={15} />
                  Submit Response
                </button>
              </>
            )}
            {(status === "connected" || status === "disconnected") && (
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span>
                  {status === "connected" ? (
                    <>Connected to Host {room.remotePeer.replace("SP-", "")}</>
                  ) : (
                    <>Connection lost.</>
                  )}
                </span>
                <button className="danger-action" onClick={onLeave}>
                  Leave Room
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

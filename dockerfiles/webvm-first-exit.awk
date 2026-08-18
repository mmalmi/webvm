# Print the first roster peer offering an IPv4 default route. Parse complete
# peer objects because nVPN's JSON field order is not part of its interface.
/"peers"[[:space:]]*:[[:space:]]*\[/ {
    in_peers = 1
    next
}

in_peers && !in_peer && /^[[:space:]]*\{[[:space:]]*$/ {
    in_peer = 1
    peer = ""
    offers_exit = 0
    next
}

in_peer && /"participant_pubkey"[[:space:]]*:/ {
    peer = $0
    sub(/^.*"participant_pubkey"[[:space:]]*:[[:space:]]*"/, "", peer)
    sub(/".*$/, "", peer)
}

in_peer && /"0\.0\.0\.0\/0"/ {
    offers_exit = 1
}

in_peer && /^[[:space:]]*\}[,]?[[:space:]]*$/ {
    if (offers_exit && peer != "") {
        print peer
        exit
    }
    in_peer = 0
    next
}

in_peers && !in_peer && /^[[:space:]]*\][,]?[[:space:]]*$/ {
    in_peers = 0
}

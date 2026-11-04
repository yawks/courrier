use serde::Serialize;
use super::{send_ews_request, xml_all_ns, xml_content_ns, xml_decode, xml_escape};

#[derive(Serialize)]
pub struct EwsRoom {
    pub name: String,
    pub email: String,
    pub directory: bool,
}

fn check_response(xml: &str) -> Result<(), String> {
    match xml_content_ns(xml, "m:ResponseCode").as_deref() {
        Some("NoError") => Ok(()),
        // Keep diagnostics free of mailbox addresses and raw server responses.
        _ => Err("ews_room_discovery_failed".into()),
    }
}

fn parse_rooms(xml: &str, tag: &str) -> Vec<EwsRoom> {
    xml_all_ns(xml, tag).iter().filter_map(|item| {
        let email = xml_decode(&xml_content_ns(item, "t:EmailAddress")?).trim().to_string();
        if email.is_empty() { return None; }
        let name = xml_content_ns(item, "t:Name").map(|name| xml_decode(&name))
            .filter(|name| !name.trim().is_empty()).unwrap_or_else(|| email.clone());
        Some(EwsRoom { name, email, directory: false })
    }).collect()
}

fn parse_directory(xml: &str) -> Result<Vec<EwsRoom>, String> {
    match xml_content_ns(xml, "m:ResponseCode").as_deref() {
        Some("ErrorNameResolutionNoResults") => return Ok(Vec::new()),
        Some("NoError" | "ErrorNameResolutionMultipleResults") => {},
        _ => return Err("ews_room_directory_failed".into()),
    }
    let mut seen = std::collections::HashSet::new();
    Ok(xml_all_ns(xml, "t:Resolution").iter().filter_map(|resolution| {
        let mailbox = xml_content_ns(resolution, "t:Mailbox")?;
        if xml_content_ns(&mailbox, "t:RoutingType").as_deref() != Some("SMTP") { return None; }
        // Distribution lists and personal contacts are not useful location candidates.
        if !matches!(xml_content_ns(&mailbox, "t:MailboxType").as_deref(), Some("Mailbox")) { return None; }
        let email = xml_decode(&xml_content_ns(&mailbox, "t:EmailAddress")?);
        if !email.contains('@') || !seen.insert(email.to_lowercase()) { return None; }
        let name = xml_content_ns(&mailbox, "t:Name").map(|name| xml_decode(&name))
            .filter(|name| !name.trim().is_empty()).unwrap_or_else(|| email.clone());
        Some(EwsRoom { name, email, directory: true })
    }).take(20).collect())
}

pub async fn ews_search_room_directory(access_token: String, query: String) -> Result<Vec<EwsRoom>, String> {
    let query = query.trim();
    if query.chars().count() < 2 { return Ok(Vec::new()); }
    if query.chars().count() > 256 { return Err("ews_room_query_too_long".into()); }
    eprintln!("[Room discovery] EWS ResolveNames started");
    let body = format!(r#"<m:ResolveNames ReturnFullContactData="false" SearchScope="ActiveDirectory"><m:UnresolvedEntry>{}</m:UnresolvedEntry></m:ResolveNames>"#, xml_escape(query));
    let xml = send_ews_request(&access_token, &body, None).await.map_err(|error| {
        eprintln!("[Room discovery] EWS ResolveNames request failed");
        error
    })?;
    let result = parse_directory(&xml).map_err(|error| {
        eprintln!("[Room discovery] EWS ResolveNames response rejected");
        error
    })?;
    eprintln!("[Room discovery] EWS ResolveNames completed: {} directory candidates", result.len());
    Ok(result)
}

pub async fn ews_discover_rooms(access_token: String) -> Result<Vec<EwsRoom>, String> {
    eprintln!("[Room discovery] EWS GetRoomLists started");
    let xml = send_ews_request(&access_token, "<m:GetRoomLists/>", None).await.map_err(|error| {
        eprintln!("[Room discovery] EWS GetRoomLists request failed");
        error
    })?;
    check_response(&xml).map_err(|error| {
        eprintln!("[Room discovery] EWS GetRoomLists response rejected");
        error
    })?;
    let lists = parse_rooms(&xml, "t:Address");
    eprintln!("[Room discovery] EWS GetRoomLists completed: {} lists", lists.len());
    if lists.is_empty() {
        eprintln!("[Room discovery] WARNING: EWS exposes no room lists; room discovery cannot enumerate rooms");
    }
    let mut rooms: Vec<EwsRoom> = Vec::new();
    let mut seen_lists = std::collections::HashSet::new();
    for (index, list) in lists.into_iter().enumerate() {
        if !seen_lists.insert(list.email.to_lowercase()) { continue; }
        eprintln!("[Room discovery] EWS GetRooms started: list {}", index + 1);
        let body = format!("<m:GetRooms><m:RoomList><t:EmailAddress>{}</t:EmailAddress></m:RoomList></m:GetRooms>", xml_escape(&list.email));
        let xml = send_ews_request(&access_token, &body, None).await.map_err(|error| {
            eprintln!("[Room discovery] EWS GetRooms request failed");
            error
        })?;
        check_response(&xml).map_err(|error| {
            eprintln!("[Room discovery] EWS GetRooms response rejected");
            error
        })?;
        let found = parse_rooms(&xml, "t:Room");
        eprintln!("[Room discovery] EWS GetRooms completed: {} rooms", found.len());
        for room in found {
            if !rooms.iter().any(|known| known.email.eq_ignore_ascii_case(&room.email)) {
                rooms.push(room);
            }
        }
    }
    rooms.sort_by_key(|room| room.name.to_lowercase());
    eprintln!("[Room discovery] EWS completed: {} unique rooms", rooms.len());
    Ok(rooms)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn directory_accepts_multiple_matches_but_excludes_groups_and_legacy_addresses() {
        let mailbox = |routing: &str, kind: &str, email: &str| format!("<t:Resolution><t:Mailbox><t:Name>Room &amp; A</t:Name><t:RoutingType>{routing}</t:RoutingType><t:MailboxType>{kind}</t:MailboxType><t:EmailAddress>{email}</t:EmailAddress></t:Mailbox></t:Resolution>");
        let xml = format!("<m:ResponseCode>ErrorNameResolutionMultipleResults</m:ResponseCode>{}{}{}{}", mailbox("SMTP", "Mailbox", "room@example.test"), mailbox("SMTP", "Mailbox", "ROOM@example.test"), mailbox("SMTP", "PublicDL", "group@example.test"), mailbox("EX", "Mailbox", "/O=Legacy"));
        let found = parse_directory(&xml).unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "Room & A");
        assert!(found[0].directory);
        assert!(parse_directory("<ResponseCode>ErrorNameResolutionNoResults</ResponseCode>").unwrap().is_empty());
        assert!(parse_directory("<ResponseCode>ErrorAccessDenied</ResponseCode>").is_err());
    }

    #[test]
    fn reads_room_lists_and_nested_room_ids_without_confusing_list_names() {
        let lists = parse_rooms("<m:RoomLists><t:Address><t:Name>Building A</t:Name><t:EmailAddress>building@example.test</t:EmailAddress></t:Address></m:RoomLists>", "t:Address");
        assert_eq!(lists[0].email, "building@example.test");
        let rooms = parse_rooms("<Rooms><Room><Id><Name>Room A &amp; B</Name><EmailAddress>room@example.test</EmailAddress></Id></Room><Room><Id><Name>No address</Name></Id></Room></Rooms>", "t:Room");
        assert_eq!(rooms.len(), 1);
        assert_eq!(rooms[0].name, "Room A & B");
        assert_eq!(rooms[0].email, "room@example.test");
    }

    #[test]
    fn rejects_soap_errors_and_malformed_responses_instead_of_claiming_no_rooms() {
        assert!(check_response("<m:ResponseCode>NoError</m:ResponseCode>").is_ok());
        assert!(check_response("<m:ResponseCode>ErrorAccessDenied</m:ResponseCode>").is_err());
        assert!(check_response("<html>Bad gateway</html>").is_err());
    }
}

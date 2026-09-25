

const determineRole = (userType) => {

    switch (userType) {
        case "student":
            return "student";
        case "client":
            return "client";

        case "tutor":
            return "tutor";
        case "provider":
            return "provider";
        case "affiliate":
            return "affiliate";
        // The persona was formerly named "partner". A client build that still
        // sends the old value must not fall through to the `default` branch
        // below, which would quietly create a student account instead.
        case "partner":
            return "affiliate";

        case "team_member":
            return "team_member";

        case "admin":
            return "admin";

        default:
            return "student";
    }

}


module.exports = determineRole;
